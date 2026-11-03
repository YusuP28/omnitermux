#!/usr/bin/env node
"use strict";

/**
 * omnitermux — CLI chat sederhana lewat OmniRoute (Combo ALL-FREE).
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
};

function cat(teks, ...kode) {
  if (!PAKAI_WARNA) return String(teks);
  return kode.join("") + teks + C.reset;
}

/* ------------------------------------------------------------ tata letak */

function lebarTampilan() {
  const paksa = Number(process.env.OMNITERMUX_LEBAR);
  if (Number.isFinite(paksa) && paksa > 0) {
    return Math.min(LEBAR_MAKS, Math.max(LEBAR_MIN, Math.floor(paksa)));
  }
  const kolom = stdout.columns || 0;
  const dasar = kolom > 0 ? kolom - 2 : 70;
  return Math.min(LEBAR_MAKS, Math.max(LEBAR_MIN, dasar));
}

/**
 * Bungkus teks per kata agar tidak melewati `lebar` kolom.
 * Indentasi awal dipertahankan, dan lanjutan butir daftar ("- ", "1. ")
 * ikut menjorok supaya rapi.
 */
function bungkus(teks, lebar) {
  const hasil = [];

  for (const mentahAsli of String(teks).replace(/\t/g, "  ").split("\n")) {
    const mentah = mentahAsli.replace(/\s+$/, "");
    if (mentah.trim() === "") {
      hasil.push("");
      continue;
    }

    const menjorok = mentah.match(/^\s*/)[0];
    const butir = /^\s*(?:[-*+]|\d+[.)])\s+/.test(mentah);
    const lanjut = menjorok + (butir ? "  " : "");

    let sisa = mentah.slice(menjorok.length);
    let awalan = menjorok;

    for (;;) {
      const lebarBaris = Math.max(10, lebar - awalan.length);
      if (sisa.length <= lebarBaris) {
        hasil.push(awalan + sisa);
        break;
      }
      let potong = sisa.lastIndexOf(" ", lebarBaris);
      if (potong <= 0) potong = lebarBaris; // kata terlalu panjang: potong paksa
      hasil.push(awalan + sisa.slice(0, potong));
      sisa = sisa.slice(potong).replace(/^\s+/, "");
      awalan = lanjut;
    }
  }

  return hasil;
}

/** Markdown ringan: **tebal** dan `kode`. Dipakai setelah teks dibungkus. */
function formatBaris(baris) {
  return baris
    .replace(/\*\*(.+?)\*\*/g, (_m, isi) => `${C.tebal}${isi}${C.tebalMati}`)
    .replace(/`([^`]+)`/g, (_m, isi) => `${C.sian}${isi}${C.putih}`);
}

function apakahTabel(baris) {
  return /^\s*\|.*\|\s*$/.test(baris);
}

function apakahPemisah(baris) {
  return /^\s*\|[\s:|-]+\|\s*$/.test(baris) && baris.includes("-");
}

/**
 * Fallback untuk tabel yang tak mungkin muat: tampilkan per baris sebagai
 * pasangan "label: nilai" agar tetap terbaca di layar sempit.
 */
function tabelVertikal(sel, pemisah, lebar) {
  const barisData = sel.filter((_, i) => !pemisah[i]);
  const judul = barisData[0] || [];
  const isi = barisData.slice(1);
  const hasil = [];

  isi.forEach((baris, indeks) => {
    baris.forEach((nilai, j) => {
      if (nilai === "") return;
      const label = judul[j] || `Kolom ${j + 1}`;
      for (const potong of bungkus(`${label}: ${nilai}`, Math.max(20, lebar - 2))) {
        hasil.push("  " + potong);
      }
    });
    if (indeks < isi.length - 1) hasil.push("");
  });

  return hasil;
}

/**
 * Rapikan tabel markdown agar muat di lebar layar: lebar kolom dikecilkan
 * proporsional dan isi sel dibungkus, bukan barisnya dipotong.
 */
function formatTabel(blok, lebar) {
  const sel = blok.map((baris) =>
    baris
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((isi) => isi.trim())
  );
  const pemisah = blok.map(apakahPemisah);
  const jumlahKolom = Math.max(1, ...sel.map((r) => r.length));

  const lebarAlami = Array.from({ length: jumlahKolom }, (_, j) =>
    Math.max(3, ...sel.filter((_, i) => !pemisah[i]).map((r) => (r[j] || "").length))
  );
  const lebarKolom = [...lebarAlami];

  const tersedia = lebar - (3 * jumlahKolom + 1);
  const MIN_KOLOM = 8;
  let total = lebarKolom.reduce((a, b) => a + b, 0);
  let iterasi = 0;

  // kecilkan kolom terlebar terus-menerus sampai muat
  while (total > tersedia && Math.min(...lebarKolom) > MIN_KOLOM && iterasi < 2000) {
    const palingLebar = lebarKolom.indexOf(Math.max(...lebarKolom));
    lebarKolom[palingLebar] -= 1;
    total -= 1;
    iterasi += 1;
  }

  // masih tidak muat meski sudah minimum: pakai tampilan vertikal
  const adaData = sel.filter((_, i) => !pemisah[i]).length > 1;
  if (total > tersedia && adaData) {
    return tabelVertikal(sel, pemisah, lebar);
  }

  const hasil = [];

  sel.forEach((barisSel, i) => {
    if (pemisah[i]) {
      hasil.push("|" + lebarKolom.map((w) => "-".repeat(w + 2)).join("|") + "|");
      return;
    }

    const terbungkus = lebarKolom.map((w, j) => bungkus(barisSel[j] || "", Math.max(5, w)));
    const tinggi = Math.max(1, ...terbungkus.map((k) => k.length));

    for (let k = 0; k < tinggi; k++) {
      const isi = lebarKolom
        .map((w, j) => (terbungkus[j][k] || "").padEnd(w))
        .join(" | ");
      hasil.push("| " + isi + " |");
    }
  });

  return hasil;
}

/** Susun badan balasan: tabel dirapikan, teks biasa dibungkus. */
function siapkanIsi(teks, lebar) {
  const barisMentah = String(teks)
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
  // tanpa terminal nyata, animasi hanya akan mengotori output
  if (!stdout.isTTY) return { berhenti() {} };

  let i = 0;
  const gambar = () => {
    const bingkai = cat(BINGKAI_SPINNER[i++ % BINGKAI_SPINNER.length], C.sian);
    stdout.write(`\r  ${bingkai} ${cat(label, C.abu)}   `);
  };

  gambar();
  const timer = setInterval(gambar, 80);

  return {
    berhenti() {
      clearInterval(timer);
      stdout.write("\r" + " ".repeat(label.length + 10) + "\r");
    },
  };
}

/* ------------------------------------------------------------ pesan galat */

function gagal(pesan) {
  throw new Error(pesan);
}

function pesanJaringan(err, url) {
  if (err && err.name === "TimeoutError") {
    return `Server tidak merespons dalam ${TIMEOUT_MS / 1000} detik (${url}).`;
  }
  const kode = err && err.cause && err.cause.code;
  if (kode === "ECONNREFUSED") {
    return `Tidak bisa terhubung ke ${url}.\nServer OmniRoute sepertinya mati. Coba jalankan: omnirouter start`;
  }
  if (kode === "ENOTFOUND" || kode === "EAI_AGAIN") {
    return `Alamat ${url} tidak bisa dijangkau (DNS gagal).`;
  }
  return `Gagal menghubungi ${url}: ${(err && err.message) || String(err)}`;
}

function pesanHTTP(status, detail) {
  const ekor = detail ? `\nDetail dari server: ${detail}` : "";
  if (status === 401 || status === 403) {
    return `API key ditolak (HTTP ${status}). Periksa variabel OMNIROUTE_API_KEY.${ekor}`;
  }
  if (status === 404) {
    return `Model "${MODEL}" tidak ditemukan di OmniRoute (HTTP 404).${ekor}`;
  }
  if (status === 429) {
    return `Kena rate limit (HTTP 429). Tunggu sebentar lalu coba lagi.${ekor}`;
  }
  if (status >= 500) {
    return `Server OmniRoute bermasalah (HTTP ${status}).${ekor}`;
  }
  return `Permintaan ditolak (HTTP ${status}).${ekor}`;
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
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
      try {
        detail = JSON.parse(teks)?.error?.message ?? teks;
      } catch {
        detail = teks;
      }
    } catch {
      // body error tidak terbaca — biarkan kosong
    }
    gagal(pesanHTTP(res.status, String(detail).slice(0, 300)));
  }

  let data;
  try {
    data = await res.json();
  } catch {
    gagal("Balasan server bukan JSON yang valid.");
  }

  const balasan = data?.choices?.[0]?.message?.content;
  if (typeof balasan !== "string") {
    gagal("Server membalas tanpa isi (choices[0].message.content tidak ada).");
  }

  return { teks: balasan, model: data?.model || MODEL };
}

function potongRiwayat(riwayat) {
  while (riwayat.length > MAKS_PESAN) riwayat.shift();
}

/* ------------------------------------------------------------------- UI */

const BANTUAN = [
  ["/help", "tampilkan bantuan ini"],
  ["/reset", "kosongkan riwayat percakapan"],
  ["/model", "tampilkan model & endpoint yang dipakai"],
  ["exit", "keluar (juga: quit, /exit, atau Ctrl+C)"],
];

function cetakBantuan(lebar) {
  for (const [perintah, arti] of BANTUAN) {
    console.log("  " + cat(perintah.padEnd(8), C.kuning) + cat(arti, C.abu));
  }
  console.log("  " + cat("Lebar tampilan", C.abu) + ": " + cat(`${lebar} kolom`, C.putih));
  console.log();
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

async function main() {
  if (!API_KEY) {
    console.error("OMNIROUTE_API_KEY belum diset.");
    console.error("  Contoh: export OMNIROUTE_API_KEY=sk-...");
    process.exitCode = 1;
    return;
  }

  const lebar = lebarTampilan();

  console.log();
  console.log("  " + cat("omnitermux", C.sian, C.tebal) + "  " + cat("· CLI chat via OmniRoute", C.abu));
  console.log("  " + cat("─".repeat(Math.max(10, lebar - 2)), C.sian));
  console.log("  " + cat("model     ", C.abu) + cat(MODEL, C.putih));
  console.log("  " + cat("endpoint  ", C.abu) + cat(BASE_URL, C.putih));
  console.log(
    "  " +
      cat("bantuan   ", C.abu) +
      cat("/help", C.kuning) +
      cat(" · ", C.abu) +
      cat("exit", C.kuning) +
      cat(" untuk keluar", C.abu)
  );
  console.log();

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: stdout.isTTY,
  });
  const riwayat = [];
  let keluar = false;

  // Ctrl+C saat menunggu input: tutup antrean baris, bukan mematikan proses
  rl.on("SIGINT", () => rl.close());

  // Baris yang sudah ter-buffer tetap diproses walau interface tertutup (EOF),
  // jadi prompt harus dijaga agar tidak dipanggil pada interface yang closed.
  const tanya = () => {
    // saat output dipipa tidak perlu prompt; juga mencegah prompt menempel
    // ke kotak balasan karena tidak ada newline dari echo terminal
    if (!stdout.isTTY) return;
    try {
      rl.prompt();
    } catch (err) {
      // interface sudah tertutup (mis. semua input habis) — tidak perlu prompt
      if (err && err.code !== "ERR_USE_AFTER_CLOSE") throw err;
    }
  };

  rl.setPrompt("  " + cat("Anda", C.hijau, C.tebal) + cat(" > ", C.abu));
  tanya();

  // Async iterator (bukan rl.question) supaya tidak ada baris yang terlewat
  // ketika input datang beruntun, misalnya saat ditempel atau lewat pipa.
  for await (const baris of rl) {
    const teks = baris.trim();

    if (teks === "exit" || teks === "quit" || teks === "/exit") {
      keluar = true;
      rl.close();
      break;
    }

    if (teks === "") {
      tanya();
      continue;
    }

    if (teks === "/help") {
      console.log();
      cetakBantuan(lebar);
      tanya();
      continue;
    }
    if (teks === "/model") {
      console.log();
      console.log("  " + cat(MODEL, C.putih) + cat(" @ ", C.abu) + cat(BASE_URL, C.putih));
      console.log();
      tanya();
      continue;
    }
    if (teks === "/reset") {
      riwayat.length = 0;
      console.log("  " + cat("Riwayat percakapan dikosongkan.", C.abu));
      console.log();
      tanya();
      continue;
    }

    riwayat.push({ role: "user", content: teks });
    potongRiwayat(riwayat);

    const spinner = mulaiSpinner("menunggu OmniRoute");
    let hasil;
    try {
      hasil = await kirimPesan(riwayat);
    } catch (err) {
      spinner.berhenti();
      cetakGalat("Gagal", err.message, lebar);
      // pesan yang gagal terkirim tidak disimpan di riwayat
      riwayat.pop();
      tanya();
      continue;
    }
    spinner.berhenti();

    riwayat.push({ role: "assistant", content: hasil.teks });
    potongRiwayat(riwayat);

    cetakBalasan(hasil, lebar);
    tanya();
  }

  console.log();
  console.log("  " + cat("Sampai jumpa.", C.sian));
  console.log();
}

main().catch((err) => {
  console.error("Terjadi kesalahan tak terduga:", err);
  process.exitCode = 1;
});

module.exports = { kirimPesan, pesanHTTP, pesanJaringan, bungkus, lebarTampilan };
