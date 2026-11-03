#!/usr/bin/env node
"use strict";

/**
 * omnitermux — CLI chat modern lewat OmniRoute (Combo ALL-FREE).
 * Hanya memakai modul bawaan Node.js, tanpa dependensi eksternal.
 */

const readline = require("node:readline");
const { stdin, stdout } = require("node:process");

/* ------------------------------------------------------------ konfigurasi */

const BASE_URL = (process.env.OMNIROUTE_BASE_URL || "http://localhost:20128/v1").replace(/\/+$/, "");
const MODEL = process.env.OMNIROUTE_MODEL || "ALL-FREE";
const API_KEY = process.env.OMNIROUTE_API_KEY;
const TIMEOUT_MS = 120_000;

// metadata combo mendeklarasikan context 4096, jadi riwayat sengaja dibatasi
const MAKS_PESAN = 20;

// batas lebar tampilan agar nyaman di layar HP (bisa dioverride lewat env)
const LEBAR_MAKS = 70;
const LEBAR_MIN = 40;

// versi aplikasi
const VERSI = "0.3.0";

/* ------------------------------------------------------------------ warna */

// Warna hanya dipakai saat output benar-benar terminal. Saat output dipipa
// (mis. ke file) semua kode ANSI dimatikan supaya teksnya bersih.
const PAKAI_WARNA = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
const esc = (kode) => (PAKAI_WARNA ? `\x1b[${kode}m` : "");

const C = {
  reset: esc(0),
  tebal: esc(1),
  tebalMati: esc(22),
  merah: esc(91),
  hijau: esc(32),
  kuning: esc(33),
  sian: esc(36),
  putih: esc(97),
  abu: esc(90),
  magenta: esc(35),
  biru: esc(34),
};

function cat(teks, ...kode) {
  if (!PAKAI_WARNA) return String(teks);
  return kode.join("") + teks + C.reset;
}

/* ------------------------------------------------------------ tata letak */

function lebarTeks(teks) {
  let lebar = 0;
  for (const karakter of String(teks).replace(/\x1b\[[0-9;]*m/g, "")) {
    const kode = karakter.codePointAt(0);
    const lebarDua =
      (kode >= 0x1100 && kode <= 0x115f) ||
      kode === 0x2329 ||
      kode === 0x232a ||
      (kode >= 0x2e80 && kode <= 0xa4cf) ||
      (kode >= 0xac00 && kode <= 0xd7a3) ||
      (kode >= 0xf900 && kode <= 0xfaff) ||
      (kode >= 0xfe30 && kode <= 0xfe6f) ||
      (kode >= 0xff00 && kode <= 0xff60) ||
      (kode >= 0xffe0 && kode <= 0xffe6) ||
      (kode >= 0x1f300 && kode <= 0x1f64f) ||
      (kode >= 0x1f680 && kode <= 0x1f6ff) ||
      (kode >= 0x1f900 && kode <= 0x1f9ff) ||
      (kode >= 0x2600 && kode <= 0x27bf);
    lebar += lebarDua ? 2 : 1;
  }
  return lebar;
}

function potongTeks(teks, batas) {
  const hasil = [];
  let dipakai = 0;
  for (const karakter of String(teks)) {
    const lebar = lebarTeks(karakter);
    if (dipakai + lebar > batas) break;
    hasil.push(karakter);
    dipakai += lebar;
  }
  return hasil;
}

function lebarTampilan() {
  const paksa = Number(process.env.OMNITERMUX_LEBAR);
  if (Number.isFinite(paksa) && paksa > 0) {
    return Math.min(LEBAR_MAKS, Math.max(LEBAR_MIN, Math.floor(paksa)));
  }
  const kolom = stdout.columns || Number(process.env.COLUMNS) || 0;
  const dasar = kolom > 0 ? kolom - 2 : 70;
  return Math.min(LEBAR_MAKS, Math.max(LEBAR_MIN, dasar));
}

function bungkus(teks, lebar) {
  const hasil = [];
  const batasTotal = Math.max(1, Math.floor(lebar));
  for (const mentahAsli of String(teks).replace(/\t/g, "  ").split("\n")) {
    const mentah = mentahAsli.replace(/\s+$/, "");
    if (mentah.trim() === "") {
      hasil.push("");
      continue;
    }
    const menjorok = mentah.match(/^\s*/)[0];
    const butir = /^\s*(?:[-*+]|\d+[.)])\s+/.test(mentah);
    const lanjut = menjorok + (butir ? "  " : "");
    let sisa = Array.from(mentah.slice(menjorok.length));
    let awalan = menjorok;
    for (;;) {
      const batas = Math.max(1, batasTotal - lebarTeks(awalan));
      const potongMuat = potongTeks(sisa, batas);
      if (potongMuat.length >= sisa.length) {
        hasil.push(awalan + sisa.join(""));
        break;
      }
      let potong = potongMuat.length;
      for (let i = potong; i > 0; i -= 1) {
        if (sisa[i] === " ") { potong = i; break; }
      }
      if (potong <= 0) potong = Math.max(1, potongMuat.length);
      hasil.push(awalan + sisa.slice(0, potong).join(""));
      sisa = sisa.slice(potong);
      while (sisa.length > 0 && sisa[0] === " ") sisa.shift();
      awalan = lanjut;
    }
  }
  return hasil;
}

function formatBaris(baris) {
  return baris
    .replace(/\*\*(.+?)\*\*/g, (_m, isi) => `${C.tebal}${isi}${C.tebalMati}`)
    .replace(/`([^`]+)`/g, (_m, isi) => `${C.sian}${isi}${C.putih}`);
}

function bersihkanTeks(teks) {
  return String(teks)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/[ \t]+$/gm, "");
}

function apakahTabel(baris) {
  const teks = baris.trim();
  return teks.startsWith("|") && (teks.match(/\|/g) || []).length >= 2;
}

function pecahSel(baris) {
  let teks = baris.trim();
  if (teks.startsWith("|")) teks = teks.slice(1);
  if (teks.endsWith("|") && !teks.endsWith("\\|")) teks = teks.slice(0, -1);
  return teks.split(/(?<!\\)\|/).map((isi) => isi.replace(/\\\|/g, "|").trim());
}

function apakahPemisah(baris) {
  const sel = pecahSel(baris);
  const adaGaris = sel.some((isi) => /^:?-{1,}:?$/.test(isi));
  const semuaGaris = sel.every((isi) => isi === "" || /^:?-{1,}:?$/.test(isi));
  return adaGaris && semuaGaris;
}

function tabelVertikal(sel, pemisah, lebar) {
  const barisData = sel.filter((_, i) => !pemisah[i]);
  const judul = barisData[0] || [];
  const isi = barisData.slice(1);
  const hasil = [];
  isi.forEach((baris, indeks) => {
    baris.forEach((nilai, j) => {
      if (nilai === "") return;
      const label = judul[j] || `Kolom ${j + 1}`;
      const teks = formatBaris(`${label}: ${nilai}`);
      for (const potong of bungkus(teks, Math.max(20, lebar - 2))) {
        hasil.push("  " + potong);
      }
    });
    if (indeks < isi.length - 1) hasil.push("");
  });
  return hasil;
}

function pad(teks, lebar) {
  const sisa = lebar - lebarTeks(teks);
  return sisa > 0 ? teks + " ".repeat(sisa) : teks;
}

function potongElipsis(teks, lebar) {
  if (lebarTeks(teks) <= lebar) return teks;
  return potongTeks(teks, Math.max(0, lebar - 1)).join("") + "…";
}

function formatTabel(blok, lebar) {
  const sel = blok.map(pecahSel);
  const pemisah = blok.map(apakahPemisah);
  const barisData = sel.filter((_, i) => !pemisah[i]);
  const jumlahKolom = Math.max(1, ...sel.map((r) => r.length));
  for (const baris of sel) {
    while (baris.length < jumlahKolom) baris.push("");
  }
  const lebarAlami = Array.from({ length: jumlahKolom }, (_, j) =>
    Math.max(3, ...barisData.map((r) => lebarTeks(r[j] || "")))
  );
  const lebarKolom = [...lebarAlami];
  const tersedia = lebar - (3 * jumlahKolom + 1);
  const MIN_KOLOM = 8;
  let total = lebarKolom.reduce((a, b) => a + b, 0);
  let iterasi = 0;
  while (total > tersedia && Math.min(...lebarKolom) > MIN_KOLOM && iterasi < 4000) {
    const palingLebar = lebarKolom.indexOf(Math.max(...lebarKolom));
    lebarKolom[palingLebar] -= 1;
    total -= 1;
    iterasi += 1;
  }
  if (total > tersedia && barisData.length > 1) {
    return tabelVertikal(sel, pemisah, lebar);
  }
  const garis = "|" + lebarKolom.map((w) => "-".repeat(w + 2)).join("|") + "|";
  const hasil = [];
  sel.forEach((barisSel, i) => {
    if (pemisah[i]) { hasil.push(garis); return; }
    const terbungkus = lebarKolom.map((w, j) => bungkus(barisSel[j] || "", w));
    const tinggi = Math.max(1, ...terbungkus.map((k) => k.length));
    for (let k = 0; k < tinggi; k += 1) {
      const isi = terbungkus
        .map((kumpulan, j) => {
          const teks = formatBaris(kumpulan[k] || "");
          return pad(potongElipsis(teks, lebarKolom[j]), lebarKolom[j]);
        })
        .join(" | ");
      hasil.push("| " + isi + " |");
    }
  });
  return hasil;
}

function siapkanIsi(teks, lebar) {
  teks = bersihkanTeks(teks);
  const barisMentah = teks
    .replace(/\t/g, "  ")
    .split("\n")
    .map((baris) => baris.replace(/\s+$/, ""));
  const hasil = [];
  for (let i = 0; i < barisMentah.length; i += 1) {
    if (apakahTabel(barisMentah[i])) {
      const blok = [];
      while (i < barisMentah.length && apakahTabel(barisMentah[i])) {
        blok.push(barisMentah[i]);
        i += 1;
      }
      i -= 1;
      hasil.push(...formatTabel(blok, lebar));
      continue;
    }
    hasil.push(...bungkus(barisMentah[i], lebar));
  }
  return hasil;
}

function bingkaiAtas(judul, lebar) {
  const label = `─ ${judul} `;
  const sisa = Math.max(0, lebar - label.length - 2);
  return cat("┌" + label + "─".repeat(sisa) + "┐", C.abu);
}

function bingkaiBawah(lebar) {
  return cat("└" + "─".repeat(Math.max(0, lebar - 2)) + "┘", C.abu);
}

/* --------------------------------------------------------------- spinner */

const BINGKAI_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function mulaiSpinner(label) {
  if (!stdout.isTTY) return { berhenti() {}, gantiLabel() {} };
  let i = 0;
  let teksLabel = label;
  const gambar = () => {
    const bingkai = cat(BINGKAI_SPINNER[i++ % BINGKAI_SPINNER.length], C.sian);
    stdout.write(`\r  ${bingkai} ${cat(teksLabel, C.abu)}   `);
  };
  gambar();
  const timer = setInterval(gambar, 80);
  return {
    berhenti() {
      clearInterval(timer);
      stdout.write("\r" + " ".repeat(teksLabel.length + 10) + "\r");
    },
    gantiLabel(labelBaru) { teksLabel = labelBaru; },
  };
}

/* ------------------------------------------------------------ token hitung */

function hitungTokenPerkiraan(teks) {
  // Perkiraan kasar: 1 token ≈ 4 karakter (Bahasa Indonesia/Inggris campur)
  // Lebih konservatif dari 3-4 char/token standar OpenAI
  return Math.ceil(String(teks).length / 3.5);
}

/* ------------------------------------------------------------ sesi & status */

const SESI = {
  mulai: Date.now(),
  tokenTotal: 0,
  modelAktif: MODEL,
  pesanDikirim: 0,
  pesanDiterima: 0,
};

function formatDurasi(ms) {
  const detik = Math.floor(ms / 1000);
  const m = Math.floor(detik / 60);
  const s = detik % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function hitungBiayaPerkiraan(token) {
  // Gratis (ALL-FREE), tapi tampilkan format standar
  return "$0.00";
}

function cetakStatusBar(lebar) {
  const sekarang = Date.now();
  const durasi = formatDurasi(sekarang - SESI.mulai);
  const model = SESI.modelAktif;
  const token = SESI.tokenTotal;
  const biaya = hitungBiayaPerkiraan(token);
  // Layout: [Model] · [Tokens] · [Cost] · [Durasi]
  const kiri = `${cat("●", C.hijau)} ${cat(model, C.putih, C.tebal)}`;
  const tengah = `${cat("tokens:", C.abu)} ${cat(token.toLocaleString(), C.kuning)}`;
  const kanan = `${cat("biaya:", C.abu)} ${cat(biaya, C.hijau)} · ${cat("durasi:", C.abu)} ${cat(durasi, C.putih)}`;
  const isi = `${kiri} ${cat("·", C.abu)} ${tengah} ${cat("·", C.abu)} ${kanan}`;
  const garis = "─".repeat(Math.max(0, lebar - lebarTeks(isi) - 2));
  console.log(cat("┌", C.abu) + isi + " " + garis + cat("┐", C.abu));
}

function cetakBanner(lebar) {
  const garis = "─".repeat(lebar);
  console.log();
  console.log("  " + cat("╭" + garis + "╮", C.sian));
  console.log("  " + cat("│", C.sian) + " " + cat("omnitermux", C.sian, C.tebal) + " ".repeat(lebar - 10) + cat("│", C.sian));
  console.log("  " + cat("│", C.sian) + cat(" " + VERSI.padStart(lebar - 2), C.abu) + cat(" │", C.sian));
  console.log("  " + cat("├" + garis + "┤", C.sian));
  console.log("  " + cat("│", C.sian) + cat(" Model: ", C.abu) + cat(MODEL, C.putih) + " ".repeat(lebar - 8 - lebarTeks(MODEL)) + cat("│", C.sian));
  console.log("  " + cat("│", C.sian) + cat(" Perintah cepat:", C.abu) + " ".repeat(lebar - 16) + cat("│", C.sian));
  console.log("  " + cat("│", C.sian) + "  " + cat("/help", C.kuning) + " " + cat("— bantuan", C.abu) + " ".repeat(lebar - 22) + cat("│", C.sian));
  console.log("  " + cat("│", C.sian) + "  " + cat("/stats", C.kuning) + " " + cat("— statistik sesi", C.abu) + " ".repeat(lebar - 26) + cat("│", C.sian));
  console.log("  " + cat("│", C.sian) + "  " + cat("/compact", C.kuning) + " " + cat("— ringkas percakapan", C.abu) + " ".repeat(lebar - 28) + cat("│", C.sian));
  console.log("  " + cat("│", C.sian) + "  " + cat("/reset", C.kuning) + " " + cat("— kosongkan riwayat", C.abu) + " ".repeat(lebar - 26) + cat("│", C.sian));
  console.log("  " + cat("│", C.sian) + "  " + cat("exit", C.kuning) + " " + cat("— keluar", C.abu) + " ".repeat(lebar - 16) + cat("│", C.sian));
  console.log("  " + cat("╰" + garis + "╯", C.sian));
  console.log();
}

function cetakBantuan(lebar) {
  const perintah = [
    ["/help", "tampilkan bantuan ini"],
    ["/stats", "tampilkan statistik sesi (token, biaya, durasi)"],
    ["/compact", "minta AI merangkum percakapan untuk hemat konteks"],
    ["/reset", "kosongkan riwayat percakapan"],
    ["/model", "tampilkan model & endpoint yang dipakai"],
    ["exit", "keluar (juga: quit, /exit, atau Ctrl+C)"],
  ];
  for (const [p, a] of perintah) {
    console.log("  " + cat(p.padEnd(8), C.kuning) + cat(a, C.abu));
  }
  console.log("  " + cat("Lebar tampilan", C.abu) + ": " + cat(`${lebar} kolom`, C.putih));
  console.log();
}

function cetakStatistik(lebar) {
  const sekarang = Date.now();
  const durasi = formatDurasi(sekarang - SESI.mulai);
  const biaya = hitungBiayaPerkiraan(SESI.tokenTotal);
  console.log();
  console.log(bingkaiAtas("Statistik Sesi", lebar));
  const item = [
    ["Model aktif", SESI.modelAktif],
    ["Pesan dikirim", SESI.pesanDikirim.toString()],
    ["Pesan diterima", SESI.pesanDiterima.toString()],
    ["Token perkiraan", SESI.tokenTotal.toLocaleString()],
    ["Biaya perkiraan", biaya],
    ["Durasi sesi", durasi],
  ];
  for (const [label, nilai] of item) {
    console.log(cat("│ ", C.abu) + cat(label.padEnd(18), C.abu) + cat("│ ", C.abu) + cat(nilai, C.putih) + " ".repeat(Math.max(1, lebar - 24 - lebarTeks(label) - lebarTeks(nilai))) + cat("│", C.abu));
  }
  console.log(bingkaiBawah(lebar));
  console.log();
}

async function mintaRingkasan(riwayat) {
  const promptRingkas = "Ringkas percakapan di atas menjadi satu paragraf padat (maks 150 kata) yang menangkap poin-poin kunci, keputusan, dan konteks penting. Jangan gunakan markdown. Bahasa Indonesia.";
  const riwayatRingkas = [...riwayat, { role: "user", content: promptRingkas }];
  const url = `${BASE_URL}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: riwayatRingkas, stream: false, max_tokens: 500 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

function cetakBalasan(hasil, lebar) {
  const dalam = Math.max(24, lebar - 4);
  console.log(bingkaiAtas(`AI · ${hasil.model}`, lebar));
  const isi = hasil.teks.trim() === "" ? "(balasan kosong)" : hasil.teks;
  for (const baris of siapkanIsi(isi, dalam)) {
    if (baris === "") {
      console.log(cat("│", C.abu));
    } else {
      console.log(cat("│ ", C.abu) + cat(formatBaris(baris), C.putih));
    }
  }
  console.log(bingkaiBawah(lebar));
  console.log();
}

function cetakGalat(judul, pesan, lebar) {
  console.log();
  console.log("  " + cat("✖ " + judul, C.merah, C.tebal));
  for (const baris of bungkus(pesan, Math.max(20, lebar - 4))) {
    console.log("    " + cat(baris, C.merah));
  }
  console.log();
}

/* -------------------------------------------------------------------- API */

async function kirimPesan(riwayat) {
  const url = `${BASE_URL}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: riwayat, stream: false }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    gagal(pesanJaringan(err, url));
  }
  if (!res.ok) {
    let detail = "";
    try {
      const teks = await res.text();
      try { detail = JSON.parse(teks)?.error?.message ?? teks; } catch { detail = teks; }
    } catch { /* abaikan */ }
    gagal(pesanHTTP(res.status, String(detail).slice(0, 300)));
  }
  let data;
  try { data = await res.json(); } catch { gagal("Balasan server bukan JSON yang valid."); }
  const balasan = data?.choices?.[0]?.message?.content;
  if (typeof balasan !== "string") gagal("Server membalas tanpa isi (choices[0].message.content tidak ada).");
  return { teks: balasan, model: data?.model || MODEL };
}

function potongRiwayat(riwayat) {
  while (riwayat.length > MAKS_PESAN) riwayat.shift();
}

function gagal(pesan) { throw new Error(pesan); }

function pesanJaringan(err, url) {
  if (err && err.name === "TimeoutError") return `Server tidak merespons dalam ${TIMEOUT_MS / 1000} detik (${url}).`;
  const kode = err && err.cause && err.cause.code;
  if (kode === "ECONNREFUSED") return `Tidak bisa terhubung ke ${url}.\nServer OmniRoute sepertinya mati. Coba jalankan: omnirouter start`;
  if (kode === "ENOTFOUND" || kode === "EAI_AGAIN") return `Alamat ${url} tidak bisa dijangkau (DNS gagal).`;
  return `Gagal menghubungi ${url}: ${(err && err.message) || String(err)}`;
}

function pesanHTTP(status, detail) {
  const ekor = detail ? `\nDetail dari server: ${detail}` : "";
  if (status === 401 || status === 403) return `API key ditolak (HTTP ${status}). Periksa variabel OMNIROUTE_API_KEY.${ekor}`;
  if (status === 404) return `Model "${MODEL}" tidak ditemukan di OmniRoute (HTTP 404).${ekor}`;
  if (status === 429) return `Kena rate limit (HTTP 429). Tunggu sebentar lalu coba lagi.${ekor}`;
  if (status >= 500) return `Server OmniRoute bermasalah (HTTP ${status}).${ekor}`;
  return `Permintaan ditolak (HTTP ${status}).${ekor}`;
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (!API_KEY) {
    console.error("OMNIROUTE_API_KEY belum diset.");
    console.error("  Contoh: export OMNIROUTE_API_KEY=sk-...");
    process.exitCode = 1;
    return;
  }

  const lebar = lebarTampilan();
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: stdout.isTTY,
  });
  const riwayat = [];
  let keluar = false;

  // Banner pembuka
  cetakBanner(lebar);

  // Ctrl+C saat menunggu input: tutup antrean baris, bukan mematikan proses
  rl.on("SIGINT", () => rl.close());

  // Penjaga prompt agar tidak error saat interface sudah tertutup
  const tanya = () => {
    if (!stdout.isTTY) return;
    try { rl.prompt(); } catch (err) {
      if (err && err.code !== "ERR_USE_AFTER_CLOSE") throw err;
    }
  };

  rl.setPrompt("  " + cat("Anda", C.hijau, C.tebal) + cat(" > ", C.abu));
  tanya();

  // Async iterator supaya tidak ada baris yang terlewat
  for await (const baris of rl) {
    const teks = baris.trim();

    if (teks === "exit" || teks === "quit" || teks === "/exit") {
      keluar = true;
      rl.close();
      break;
    }
    if (teks === "") { tanya(); continue; }

    // Perintah slash
    if (teks === "/help") { console.log(); cetakBantuan(lebar); tanya(); continue; }
    if (teks === "/stats") { console.log(); cetakStatistik(lebar); tanya(); continue; }
    if (teks === "/model") { console.log(); console.log("  " + cat(MODEL, C.putih) + cat(" @ ", C.abu) + cat(BASE_URL, C.putih)); console.log(); tanya(); continue; }
    if (teks === "/reset") { riwayat.length = 0; SESI.tokenTotal = 0; SESI.pesanDikirim = 0; SESI.pesanDiterima = 0; console.log("  " + cat("Riwayat percakapan dikosongkan.", C.abu)); console.log(); tanya(); continue; }
    if (teks === "/compact") {
      console.log();
      const spinner = mulaiSpinner("meminta ringkasan ke AI");
      const ringkasan = await mintaRingkasan(riwayat);
      spinner.berhenti();
      if (ringkasan) {
        riwayat.length = 0;
        riwayat.push({ role: "user", content: "[Ringkasan percakapan sebelumnya]" });
        riwayat.push({ role: "assistant", content: ringkasan });
        console.log("  " + cat("Percakapan diringkas:", C.hijau));
        console.log("  " + cat(ringkasan, C.putih));
        console.log();
        SESI.tokenTotal = hitungTokenPerkiraan(ringkasan);
      } else {
        console.log("  " + cat("Gagal membuat ringkasan.", C.merah));
      }
      console.log();
      tanya();
      continue;
    }

    // Pesan biasa
    riwayat.push({ role: "user", content: teks });
    potongRiwayat(riwayat);
    SESI.pesanDikirim += 1;
    SESI.tokenTotal += hitungTokenPerkiraan(teks);

    // Status bar di atas spinner
    cetakStatusBar(lebar);

    const spinner = mulaiSpinner("Berpikir...");
    let hasil;
    try {
      hasil = await kirimPesan(riwayat);
    } catch (err) {
      spinner.berhenti();
      cetakGalat("Gagal", err.message, lebar);
      riwayat.pop();
      SESI.pesanDikirim -= 1;
      SESI.tokenTotal -= hitungTokenPerkiraan(teks);
      tanya();
      continue;
    }
    spinner.berhenti();

    riwayat.push({ role: "assistant", content: hasil.teks });
    potongRiwayat(riwayat);
    SESI.pesanDiterima += 1;
    SESI.tokenTotal += hitungTokenPerkiraan(hasil.teks);
    SESI.modelAktif = hasil.model;

    cetakBalasan(hasil, lebar);
    tanya();
  }

  console.log();
  console.log("  " + cat("Sampai jumpa.", C.sian));
  console.log();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Terjadi kesalahan tak terduga:", err);
    process.exitCode = 1;
  });
}

module.exports = {
  kirimPesan,
  pesanHTTP,
  pesanJaringan,
  bungkus,
  lebarTampilan,
  lebarTeks,
  siapkanIsi,
  formatTabel,
};