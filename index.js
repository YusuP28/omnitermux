#!/usr/bin/env node
"use strict";

/**
 * omnitermux — CLI chat modern lewat OmniRoute (Combo ALL-FREE).
 * Tool Calling (OpenAI Function Calling) + Workspace sandbox.
 * Hanya modul bawaan Node.js, tanpa dependensi eksternal.
 */

const readline = require("node:readline");
const { stdin, stdout } = require("node:process");
const { daftarTools, eksekusiTool } = require("./tools.js");

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
const VERSI = "0.4.0";

/* ------------------------------------------------------------------ warna */

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
  return "$0.00";
}

function cetakStatusBar(lebar) {
  const sekarang = Date.now();
  const durasi = formatDurasi(sekarang - SESI.mulai);
  const model = SESI.modelAktif;
  const token = SESI.tokenTotal;
  const biaya = hitungBiayaPerkiraan(token);
  const kiri = `${cat("●", C.hijau)} ${cat(model, C.putih, C.tebal)}`;
  const tengah = `${cat("tokens:", C.abu)} ${cat(token.toLocaleString(), C.kuning)}`;
  const kanan = `${cat("biaya:", C.abu)} ${cat(biaya, C.hijau)} · ${cat("durasi:", C.abu)} ${cat(durasi, C.putih)}`;
  const isi = `${kiri} ${cat("·", C.abu)} ${tengah} ${cat("·", C.abu)} ${kanan}`;
  const garis = "─".repeat(Math.max(0, lebar - lebarTeks(isi) - 2));
  console.log(cat("┌", C.abu) + isi + " " + garis + cat("┐", C.abu));
}

/* ------------------------------------------------------------ UI: tool */

function cetakToolCall(namaTool, argumen) {
  const label = cat("🔧", C.magenta) + " " + cat(namaTool, C.putih, C.tebal);
  let detail = "";
  if (namaTool === "read_file") detail = `file: ${argumen.path}`;
  else if (namaTool === "write_file") detail = `file: ${argumen.path} (${argumen.content.length} char)`;
  else if (namaTool === "run_command") detail = `cmd: ${argumen.command}`;
  console.log("  " + label + (detail ? " " + cat(detail, C.abu) : ""));
}

async function mintaKonfirmasi(namaTool, argumen) {
  if (process.env.OMNITERMUX_AUTO_APPROVE === "1") return true;
  const teks = cat("⚠️  ", C.kuning) + cat("Izinkan ", C.putih) + cat(namaTool, C.putih, C.tebal) + cat("?", C.putih);
  if (!stdout.isTTY) return false;
  return new Promise((resolve) => {
    process.stdout.write("  " + teks + " " + cat("(y/N) ", C.kuning) + " ");
    let buffer = "";
    const onData = (chunk) => { buffer += chunk; };
    const onEnd = () => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      const input = buffer.trim();
      resolve(input.toLowerCase() === "y");
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    setTimeout(() => { stdin.removeListener("data", onData); resolve(false); }, 10_000);
  });
}

/* ------------------------------------------------------------ tool execution loop */

async function eksekusiToolCalls(riwayat, toolCalls, rl, lebar) {
  for (const call of toolCalls) {
    const { id, function: fn } = call;
    const namaTool = fn.name;
    let argumen;
    try { argumen = JSON.parse(fn.arguments); } catch { argumen = {}; }

    // Tampilkan indikator tool call
    cetakToolCall(namaTool, argumen);

    // Konfirmasi untuk tool yang mengubah state
    let diizinkan = true;
    if (namaTool === "write_file" || namaTool === "run_command") {
      diizinkan = await mintaKonfirmasi(namaTool, argumen);
    }

    let hasilTool;
    if (!diizinkan) {
      hasilTool = { ok: false, error: "Ditolak oleh pengguna" };
      console.log("  " + cat("⛔ Ditolak oleh pengguna", C.merah));
    } else {
      try {
        hasilTool = await eksekusiTool(namaTool, argumen);
      } catch (err) {
        hasilTool = { ok: false, error: err.message };
      }
    }

    // Kirim hasil kembali ke riwayat sebagai role "tool"
    const content = typeof hasilTool === "object" ? JSON.stringify(hasilTool) : String(hasilTool);
    riwayat.push({
      role: "tool",
      tool_call_id: id,
      content: content,
    });

    // Tampilkan ringkasan hasil
    if (hasilTool.ok) {
      let ringkasan = "✅ Berhasil";
      if (hasilTool.content) ringkasan += `: ${String(hasilTool.content).slice(0, 100)}`;
      else if (hasilTool.stdout) ringkasan += `: ${hasilTool.stdout.slice(0, 100)}`;
      else if (hasilTool.written) ringkasan += `: ${hasilTool.written} bytes written`;
      console.log("  " + cat(ringkasan, C.hijau));
    } else {
      const err = hasilTool.error || "Error tidak diketahui";
      console.log("  " + cat("❌ " + err, C.merah));
    }
  }
}

/* ------------------------------------------------------------ API dengan tool loop */

async function kirimPesanDenganTool(riwayat, rl, lebar) {
  const url = `${BASE_URL}/chat/completions`;

  while (true) {
    let res;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, messages: riwayat, tools: daftarTools, tool_choice: "auto", stream: false }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      gagal(pesanJaringan(err, BASE_URL));
    }
    if (!res.ok) {
      let detail = "";
      try {
        const teks = await res.text();
        try { detail = JSON.parse(teks)?.error?.message ?? teks; } catch { detail = teks; }
      } catch {}
      gagal(pesanHTTP(res.status, String(detail).slice(0, 300)));
    }
    let data;
    try { data = await res.json(); } catch { gagal("Balasan server bukan JSON yang valid."); }

    const choice = data?.choices?.[0];
    if (!choice) gagal("Server tidak mengembalikan choices.");

    const message = choice.message;
    const toolCalls = message.tool_calls;

    // Simpan pesan assistant (bisa berisi content + tool_calls)
    riwayat.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: toolCalls || undefined,
    });

    if (!toolCalls || toolCalls.length === 0) {
      // Balasan final (teks biasa)
      const balasan = message.content;
      if (typeof balasan !== "string") gagal("Server membalas tanpa isi (choices[0].message.content tidak ada).");
      return { teks: balasan, model: data?.model || MODEL };
    }

    // Ada tool_calls → eksekusi loop
    await eksekusiToolCalls(riwayat, toolCalls, rl, lebar);

    // Loop kembali: kirim riwayat (termasuk hasil tool) ke API lagi
    // Status bar sudah dicetak di main loop, tidak perlu cetak ulang di sini
  }
}

/* ------------------------------------------------------------ token & status */

function hitungTokenPerkiraan(teks) { return Math.ceil(String(teks).length / 3.5); }

function formatDurasi(ms) { const d = Math.floor(ms/1000); const m=Math.floor(d/60); const s=d%60; return m>0?`${m}m ${s}s`:`${s}s`; }
function hitungBiayaPerkiraan(t) { return "$0.00"; }

function cetakStatusBar(lebar) {
  const s = Date.now();
  const durasi = formatDurasi(s - SESI.mulai);
  const model = SESI.modelAktif;
  const token = SESI.tokenTotal;
  const biaya = hitungBiayaPerkiraan(token);
  const kiri = `${cat("●", C.hijau)} ${cat(model, C.putih, C.tebal)}`;
  const tengah = `${cat("tokens:", C.abu)} ${cat(token.toLocaleString(), C.kuning)}`;
  const kanan = `${cat("biaya:", C.abu)} ${cat(biaya, C.hijau)} · ${cat("durasi:", C.abu)} ${cat(durasi, C.putih)}`;
  const isi = `${kiri} ${cat("·", C.abu)} ${tengah} ${cat("·", C.abu)} ${kanan}`;
  const garis = "─".repeat(Math.max(0, lebar - lebarTeks(isi) - 2));
  console.log(cat("┌", C.abu) + isi + " " + garis + cat("┐", C.abu));
}

/* ------------------------------------------------------------ UI: banner, help, stats */

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
  for (const [p, a] of perintah) console.log("  " + cat(p.padEnd(8), C.kuning) + cat(a, C.abu));
  console.log("  " + cat("Lebar tampilan", C.abu) + ": " + cat(`${lebar} kolom`, C.putih));
  console.log();
}

function cetakStatistik(lebar) {
  const s = Date.now();
  const durasi = formatDurasi(s - SESI.mulai);
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
  const prompt = "Ringkas percakapan di atas menjadi satu paragraf padat (maks 150 kata) yang menangkap poin-poin kunci, keputusan, dan konteks penting. Jangan gunakan markdown. Bahasa Indonesia.";
  const url = `${BASE_URL}/chat/completions`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [...riwayat, { role: "user", content: prompt }], stream: false, max_tokens: 500 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

/* ------------------------------------------------------------ cetak balasan & error */

function cetakBalasan(hasil, lebar) {
  const dalam = Math.max(24, lebar - 4);
  console.log(bingkaiAtas(`AI · ${hasil.model}`, lebar));
  const isi = hasil.teks.trim() === "" ? "(balasan kosong)" : hasil.teks;
  for (const baris of siapkanIsi(isi, dalam)) {
    if (baris === "") console.log(cat("│", C.abu));
    else console.log(cat("│ ", C.abu) + cat(formatBaris(baris), C.putih));
  }
  console.log(bingkaiBawah(lebar));
  console.log();
}

function cetakGalat(judul, pesan, lebar) {
  console.log();
  console.log("  " + cat("✖ " + judul, C.merah, C.tebal));
  for (const baris of bungkus(pesan, Math.max(20, lebar - 4))) console.log("    " + cat(baris, C.merah));
  console.log();
}

/* ------------------------------------------------------------ util error */

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

/* ------------------------------------------------------------ main */

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
  const riwayat = [
    {
      role: "system",
      content: "Kamu adalah asisten AI yang memiliki akses ke tool: read_file, write_file, run_command. " +
        "GUNAKAN TOOL LANGSUNG tanpa menanyakan izin via teks. " +
        "Jika user minta baca/tulis file atau jalankan perintah, PANGGIL TOOL LANGSUNG. " +
        "Jangan tanya 'Apakah Anda mengizinkan?' via chat. " +
        "Tool confirmation ditangani oleh sistem, bukan olehmu. " +
        "Bahasa Indonesia."
    }
  ];
  let keluar = false;

  cetakBanner(lebar);

  rl.on("SIGINT", () => rl.close());

  const tanya = () => {
    if (!stdout.isTTY) return;
    try { rl.prompt(); } catch (err) {
      if (err && err.code !== "ERR_USE_AFTER_CLOSE") throw err;
    }
  };

  rl.setPrompt("  " + cat("USER", C.hijau, C.tebal) + cat(" > ", C.abu));
  tanya();

  for await (const baris of rl) {
    const teks = baris.trim();

    if (teks === "exit" || teks === "quit" || teks === "/exit") { keluar = true; rl.close(); break; }
    if (teks === "") { tanya(); continue; }

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
      } else { console.log("  " + cat("Gagal membuat ringkasan.", C.merah)); }
      console.log(); tanya(); continue;
    }

    // Pesan user biasa
    riwayat.push({ role: "user", content: teks });
    potongRiwayat(riwayat);
    SESI.pesanDikirim += 1;
    SESI.tokenTotal += hitungTokenPerkiraan(teks);

    // Status bar
    cetakStatusBar(lebar);

    // Spinner
    const spinner = mulaiSpinner("Berpikir...");
    let hasil;
    try {
      hasil = await kirimPesanDenganTool(riwayat, rl, lebar);
    } catch (err) {
      spinner.berhenti();
      cetakGalat("Gagal", err.message, lebar);
      riwayat.pop();
      SESI.pesanDikirim -= 1;
      SESI.tokenTotal -= hitungTokenPerkiraan(teks);
      tanya(); continue;
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

/* ------------------------------------------------------------ util & export */

function potongRiwayat(r) { while (r.length > MAKS_PESAN) r.shift(); }
function gagal(p) { throw new Error(p); }
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

if (require.main === module) {
  main().catch((err) => { console.error("Terjadi kesalahan tak terduga:", err); process.exitCode = 1; });
}

module.exports = { kirimPesanDenganTool, pesanHTTP, pesanJaringan, bungkus, lebarTampilan, lebarTeks, siapkanIsi, formatTabel };