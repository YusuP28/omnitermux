#!/usr/bin/env node
"use strict";

/**
 * omnitermux — CLI chat modern dengan Tool Calling + Multi-Provider support.
 * Hanya modul bawaan Node.js, tanpa dependensi eksternal.
 */

const readline = require("node:readline");
const { stdin, stdout } = require("node:process");
const { daftarTools, eksekusiTool } = require("./tools.js");
const { bacaConfig, jalankanSetup, CONFIG_FILE, CONFIG_DIR, DIRECT_PROVIDERS } = require("./setup.js");

/* ------------------------------------------------------------ konfigurasi */

// Konfigurasi akan dimuat dari ~/.config/omnitermux/config.json
// Fallback ke env vars untuk backward compatibility
let BASE_URL = "";
let MODEL = "";
let API_KEY = "";
let PROVIDER_KEY = "";
const TIMEOUT_MS = 120_000;

// metadata combo mendeklarasikan context 4096, jadi riwayat sengaja dibatasi
const MAKS_PESAN = 20;

// Mode agen (adopsi OpenCode2): "build" = penuh, "plan" = hanya baca
let MODE_AKTIF = "build";

// Agent Skills (terinspirasi Matt Pocock) — aktif selama sesi berjalan
let activeSkill = null; // { nama, isi } | null
const SKILL_TERSEDIA = ["grill-me", "tdd", "code-review"];

// Whitelist perintah yang diizinkan di mode PLAN (hanya inspeksi/read-only).
// Pola: cek token pertama (atau awalan berjarak), dilarang ada karakter
// rantai/redirect shell ( ; & | > < ) agar tidak bisa menyelipkan perintah lain.
const PLAN_WHITELIST = [
  "ls", "cat", "pwd", "head", "tail", "wc", "grep", "find", "stat", "du", "df",
  "which", "file", "date", "whoami", "uname", "echo",
  "git status", "git diff", "git log", "git branch", "git remote -v", "git show",
  "node --version", "npm --version", "python --version",
];

function perintahPlanDiizinkan(command) {
  const c = String(command || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!c) return false;
  if (/[;&|><]/.test(c)) return false; // tanpa chaining, pipe, atau redirect
  return PLAN_WHITELIST.some((p) => c === p || c.startsWith(p + " "));
}

// batas lebar tampilan agar nyaman di layar HP (bisa dioverride lewat env)
const LEBAR_MAKS = 70;
const LEBAR_MIN = 40;

// versi aplikasi
const VERSI = "0.5.0";

/* ------------------------------------------------------------------ warna */

// Warna hanya dipakai saat output benar-benar terminal. Saat output dipipa
// (mis. ke file) semua kode ANSI dimatikan supaya teksnya bersih.
const PAKAI_WARNA = (Boolean(stdout.isTTY) || Boolean(process.env.FORCE_COLOR)) && !process.env.NO_COLOR;
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

/* ------------------------------------- syntax highlighting (Fase 7, tanpa deps) */

// Palet: kata kunci → sian, literal/fungsi → biru, string → hijau,
// komentar → abu, angka → magenta. Konsisten dengan palet UI utama.
const KATA_KUNCI_JS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
  "switch", "case", "break", "continue", "new", "class", "extends", "super", "this",
  "typeof", "instanceof", "try", "catch", "finally", "throw", "await", "async",
  "import", "export", "from", "require", "default", "delete", "void", "in", "of",
  "yield", "static", "interface", "enum", "type", "as", "satisfies",
]);
const KATA_KUNCI_PY = new Set([
  "def", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or",
  "import", "from", "as", "class", "try", "except", "finally", "raise", "with",
  "lambda", "yield", "pass", "break", "continue", "global", "nonlocal", "assert",
  "del", "async", "await",
]);
const KATA_KUNCI_SH = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac",
  "function", "return", "exit", "echo", "export", "local", "source", "read", "set",
  "unset", "trap", "shift", "select", "until", "cd", "alias",
]);
const KATA_KUNCI_SQL = new Set([
  "select", "from", "where", "insert", "into", "values", "update", "set", "delete",
  "create", "table", "drop", "alter", "add", "column", "join", "inner", "left",
  "right", "outer", "full", "on", "group", "by", "order", "having", "limit",
  "offset", "union", "all", "distinct", "as", "and", "or", "not", "null", "is",
  "like", "between", "exists", "primary", "key", "foreign", "references", "index",
  "with", "case", "when", "then", "end", "asc", "desc",
]);
const LITERALS = new Set([
  "true", "false", "null", "undefined", "nan", "infinity", "none", "nil", "self", "console",
]);
const KATA_KUNCI_UMUM = new Set([...KATA_KUNCI_JS, ...KATA_KUNCI_PY, ...KATA_KUNCI_SH, ...KATA_KUNCI_SQL]);
const TANPA_KATA = new Set();

// Aturan per bahasa: pola komentar (sticky) + daftar kata kunci (lowercase).
function aturanBahasa(bahasa) {
  const b = String(bahasa || "").toLowerCase();
  const JS = ["js", "jsx", "mjs", "cjs", "javascript", "typescript", "ts", "tsx", "node", "vue", "svelte"];
  const PY = ["py", "python", "python3"];
  const SH = ["sh", "bash", "shell", "zsh", "console", "termux"];
  const SQL = ["sql", "mysql", "postgres", "pgsql", "sqlite"];
  if (JS.includes(b)) return { komentar: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y, kata: KATA_KUNCI_JS };
  if (PY.includes(b)) return { komentar: /#[^\n]*/y, kata: KATA_KUNCI_PY };
  if (SH.includes(b)) return { komentar: /#[^\n]*/y, kata: KATA_KUNCI_SH };
  if (SQL.includes(b)) return { komentar: /--[^\n]*|\/\*[\s\S]*?\*\//y, kata: KATA_KUNCI_SQL, hurufBesar: false };
  if (b === "json") return { komentar: null, kata: LITERALS };
  if (["html", "xml", "svg"].includes(b)) return { komentar: /<!--[\s\S]*?-->/y, kata: TANPA_KATA };
  if (["css", "scss", "less"].includes(b)) return { komentar: /\/\*[\s\S]*?\*\//y, kata: TANPA_KATA };
  if (["md", "markdown", "text", "txt"].includes(b)) return { komentar: null, kata: TANPA_KATA };
  // bahasa tak dikenal → campuran aman
  return { komentar: /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//y, kata: KATA_KUNCI_UMUM };
}

// Warnai satu baris/blok kode. Token diberi warna lalu dikembalikan ke putih
// agar warna teks frame (putih) tetap hidup setelah token berwarna.
function warnaiKode(kode, bahasa) {
  if (!PAKAI_WARNA || !kode) return String(kode);
  const aturan = aturanBahasa(bahasa);
  const reKomentar = aturan.komentar || null;
  const reString = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/y;
  const reAngka = /(?:0[xX][\da-fA-F]+|\d[\d_]*(?:\.\d+)?)/y;
  const reKata = /[A-Za-z_$][\w$]*/y;
  const ke = (re, pos) => { re.lastIndex = pos; return re.exec(String(kode)); };
  const s = String(kode);
  let i = 0;
  let hasil = "";
  while (i < s.length) {
    let m = null;
    if (reKomentar && (m = ke(reKomentar, i))) {
      hasil += C.abu + m[0] + C.putih; i += m[0].length; continue;
    }
    if ((m = ke(reString, i))) {
      hasil += C.hijau + m[0] + C.putih; i += m[0].length; continue;
    }
    if ((m = ke(reAngka, i))) {
      hasil += C.magenta + m[0] + C.putih; i += m[0].length; continue;
    }
    if ((m = ke(reKata, i))) {
      const kata = m[0];
      const rendah = kata.toLowerCase();
      if (LITERALS.has(rendah)) {
        hasil += C.biru + kata + C.putih;
      } else if (aturan.kata.has(rendah)) {
        hasil += C.sian + kata + C.putih;
      } else {
        // fungsi: identifier yang diikuti "(" → biru
        let j = i + kata.length;
        while (j < s.length && (s[j] === " " || s[j] === "\t")) j += 1;
        hasil += s[j] === "(" ? C.biru + kata + C.putih : kata;
      }
      i += kata.length;
      continue;
    }
    hasil += s[i];
    i += 1;
  }
  return hasil;
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

function bersihkanSel(teks) {
  return String(teks || "").replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();
}

// Lebar teks SETELAH marker markdown (** dan `) dirender — dipakai untuk
// mengukur kolom agar garis tabel tidak melar/pecah.
function lebarPantulan(teks) {
  return lebarTeks(String(teks).replace(/\*\*/g, "").replace(/`/g, ""));
}

// Potong teks berisi ANSI escape dengan aman: escape sequence dihitung lebar 0.
function potongANSI(teks, batas) {
  const s = String(teks);
  let hasil = "";
  let dipakai = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) { hasil += m[0]; i += m[0].length; continue; }
    }
    const w = lebarTeks(s[i]);
    if (dipakai + w > batas) break;
    hasil += s[i];
    dipakai += w;
    i += 1;
  }
  return hasil;
}

// Ratakan teks ke lebar kolom (kiri/tengah/kanan) berdasarkan baris pemisah.
function sejajar(teks, lebar, alini) {
  const sisa = lebar - lebarTeks(teks);
  if (sisa <= 0) return teks;
  if (alini === "kanan") return " ".repeat(sisa) + teks;
  if (alini === "tengah") {
    const kiri = Math.floor(sisa / 2);
    return " ".repeat(kiri) + teks + " ".repeat(sisa - kiri);
  }
  return teks + " ".repeat(sisa);
}

function tabelVertikal(sel, pemisah, lebar) {
  const barisData = sel.filter((_, i) => !pemisah[i]);
  const judul = barisData[0] || [];
  const isi = barisData.slice(1);
  const hasil = [];
  const lebarKotak = Math.max(24, lebar);
  const dalam = Math.max(16, lebarKotak - 4);
  const labelMaks = Math.min(
    Math.max(4, ...judul.map((h) => lebarPantulan(h))),
    Math.max(4, dalam - 8)
  );
  isi.forEach((baris, idx) => {
    if (idx > 0) hasil.push(""); // jarak antar baris data
    const topik = ` data ${idx + 1} `;
    hasil.push(cat("╭" + topik + "─".repeat(Math.max(0, lebarKotak - 2 - topik.length)) + "╮", C.abu));
    baris.forEach((nilai, j) => {
      if (nilai === "") return;
      const label = judul[j] || `Kolom ${j + 1}`;
      const polos = `${pad(label, labelMaks)}: ${nilai}`;
      const potongan = bungkus(polos, dalam);
      potongan.forEach((p, k) => {
        let tampil;
        if (k === 0) {
          const m = p.match(/^([^:]+)(:[\s\S]*)$/);
          tampil = m ? cat(m[1] + ":", C.sian, C.tebal) + cat(m[2].slice(1), C.putih) : cat(p, C.putih);
        } else {
          tampil = cat(p, C.putih);
        }
        const sisa = Math.max(0, dalam - lebarTeks(p));
        hasil.push(cat("│ ", C.abu) + tampil + " ".repeat(sisa) + cat(" │", C.abu));
      });
    });
    hasil.push(cat("╰" + "─".repeat(lebarKotak - 2) + "╯", C.abu));
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
    for (let j = 0; j < baris.length; j += 1) baris[j] = bersihkanSel(baris[j]);
  }

  // Perataan kolom dari baris pemisah (:--- kiri, ---: kanan, :-: tengah)
  const indeksPemisah = sel.findIndex((_, i) => pemisah[i]);
  const alini = Array.from({ length: jumlahKolom }, (_, j) => {
    const s = indeksPemisah >= 0 ? (sel[indeksPemisah][j] || "") : "";
    if (s.startsWith(":") && s.endsWith(":")) return "tengah";
    if (s.endsWith(":")) return "kanan";
    return "kiri";
  });

  // Ukur kolom pada teks TANPA marker markdown agar garis tetap lurus
  const lebarAlami = Array.from({ length: jumlahKolom }, (_, j) =>
    Math.max(3, ...barisData.map((r) => lebarPantulan(r[j] || "")))
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
  // Terlalu lebar untuk layar → ubah otomatis jadi format vertikal (Label: Nilai)
  if (total > tersedia && barisData.length > 1) {
    return tabelVertikal(sel, pemisah, lebar);
  }
  const garis = "│" + lebarKolom.map((w) => "─".repeat(w + 2)).join("│") + "│";
  const hasil = [];
  sel.forEach((barisSel, i) => {
    if (pemisah[i]) { hasil.push(cat(garis, C.abu)); return; }
    const terbungkus = lebarKolom.map((w, j) => bungkus(barisSel[j] || "", w));
    const tinggi = Math.max(1, ...terbungkus.map((k) => k.length));
    for (let k = 0; k < tinggi; k += 1) {
      const isi = terbungkus
        .map((kumpulan, j) => {
          // render dulu → potong (aman ANSI) → ratakan → lebar kolom tepat
          const dirender = formatBaris(kumpulan[k] || "");
          return sejajar(potongANSI(dirender, lebarKolom[j]), lebarKolom[j], alini[j]);
        })
        .join(" │ ");
      hasil.push(cat("│ ", C.abu) + isi + cat(" │", C.abu));
    }
  });
  return hasil;
}

// Render blok kode: label bahasa + tiap baris diberi indent & syntax highlighting.
function renderBlokKode(blok, bahasa, lebar) {
  const hasil = [];
  hasil.push(cat(`  ─ ${bahasa || "kode"}`, C.sian, C.tebal));
  const dalam = Math.max(8, lebar - 2); // sisakan 2 spasi indent
  for (const barisAsli of (blok.length > 0 ? blok : [""])) {
    for (const p of bungkus(barisAsli, dalam)) {
      hasil.push(p === "" ? "" : "  " + warnaiKode(p, bahasa));
    }
  }
  hasil.push(""); // jarak setelah blok kode
  return hasil;
}

function siapkanIsi(teks, lebar) {
  teks = bersihkanTeks(teks);
  const barisMentah = teks
    .replace(/\t/g, "  ")
    .split("\n")
    .map((baris) => baris.replace(/\s+$/, ""));
  const hasil = [];
  let i = 0;
  while (i < barisMentah.length) {
    const baris = barisMentah[i];

    // Blok kode berpagar ``` — warnai sintaksnya
    const pagar = baris.match(/^\s*```(.*)$/);
    if (pagar) {
      const info = pagar[1].trim();
      const bahasa = info ? info.split(/\s+/)[0].toLowerCase() : "";
      const kode = [];
      i += 1;
      while (i < barisMentah.length && !/^\s*```/.test(barisMentah[i])) {
        kode.push(barisMentah[i]);
        i += 1;
      }
      i += 1; // lewati pagar penutup (atau habis jika tidak ditutup)
      hasil.push(...renderBlokKode(kode, bahasa, lebar));
      continue;
    }

    if (apakahTabel(baris)) {
      const blok = [];
      while (i < barisMentah.length && apakahTabel(barisMentah[i])) {
        blok.push(barisMentah[i]);
        i += 1;
      }
      hasil.push(...formatTabel(blok, lebar));
      continue;
    }

    hasil.push(...bungkus(baris, lebar).map((b) => formatBaris(b)));
    i += 1;
  }
  return hasil;
}

function bingkaiAtas(judul, lebar, warna = C.abu) {
  const label = `─ ${judul} `;
  const sisa = Math.max(0, lebar - lebarTeks(label) - 2);
  return cat("╭" + label + "─".repeat(sisa) + "╮", warna, C.tebal);
}

function bingkaiBawah(lebar, warna = C.abu) {
  return cat("╰" + "─".repeat(Math.max(0, lebar - 2)) + "╯", warna, C.tebal);
}

// Cetak baris siap-tampil (dari siapkanIsi) di dalam bingkai │ ... │
// dengan padding kanan rapi. Warna teks dasar = putih.
function cetakIsiBingkai(baris, lebarIsi, warna = C.abu) {
  for (const b of baris) {
    if (b === "") { console.log(cat("│", warna)); continue; }
    const sisa = Math.max(1, lebarIsi - lebarTeks(b));
    console.log(cat("│ ", warna) + C.putih + b + C.reset + " ".repeat(sisa) + cat("│", warna));
  }
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

function potongRiwayat(riwayat) {
  while (riwayat.length > MAKS_PESAN) riwayat.shift();
}

/* ------------------------------------------------------------ sesi & status */

let SESI;

function formatDurasi(ms) {
  const detik = Math.floor(ms / 1000);
  const m = Math.floor(detik / 60);
  const s = detik % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function hitungBiayaPerkiraan(token) {
  return "$0.00";
}

// Format token ringkas: 999 → "999", 1200 → "1.2k", 1500000 → "1.5M"
function formatTokenSingkat(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

// Status bar premium: [BUILD] │ model │ 1.2k tokens │ $0.00 │ 2m 15s
function cetakStatusBar(lebar) {
  const durasi = formatDurasi(Date.now() - SESI.mulai);
  const pisah = cat(" │ ", C.abu);
  const tagMode = MODE_AKTIF === "plan"
    ? cat("[PLAN]", C.kuning, C.tebal)
    : cat("[BUILD]", C.hijau, C.tebal);
  const tagSkill = activeSkill
    ? cat(`[SKILL: ${activeSkill.nama}]`, C.magenta, C.tebal)
    : "";
  const ekor = [
    cat(`${formatTokenSingkat(SESI.tokenTotal)} tokens`, C.kuning),
    cat(hitungBiayaPerkiraan(SESI.tokenTotal), C.hijau),
    cat(durasi, C.putih),
  ];

  // Susun bagian; model diberi sisa ruang (dipotong jika kepanjangan).
  const susun = (kepalaMentah) => {
    const kepala = kepalaMentah.filter(Boolean);
    const lebarTetap =
      kepala.reduce((a, b) => a + lebarTeks(b), 0) +
      ekor.reduce((a, b) => a + lebarTeks(b), 0) +
      lebarTeks(pisah) * (kepala.length + ekor.length);
    const anggaran = Math.max(8, lebar - 2 - lebarTetap);
    const model = potongElipsis(SESI.modelAktif, anggaran);
    return [...kepala, cat(model, C.putih, C.tebal), ...ekor];
  };

  let bagian = susun([tagMode, tagSkill]);
  let isi = bagian.join(pisah);
  // Layar sempit + skill aktif → lepas tag skill dulu agar tidak meluber
  if (lebarTeks(isi) > lebar - 2) {
    bagian = susun([tagMode, ""]);
    isi = bagian.join(pisah);
  }
  const sisa = Math.max(0, lebar - 2 - lebarTeks(isi));
  console.log(cat("╭", C.abu) + isi + cat("─".repeat(sisa), C.abu) + cat("╮", C.abu));
}

/* ------------------------------------------------------------ UI: tool */

function cetakToolCall(namaTool, argumen) {
  const label = cat("🔧", C.magenta) + " " + cat(namaTool, C.putih, C.tebal);
  let detail = "";
  if (namaTool === "read_file") detail = `file: ${argumen.path}`;
  else if (namaTool === "write_file") detail = `file: ${argumen.path} (${argumen.content.length} char)`;
  else if (namaTool === "edit_file") detail = `file: ${argumen.path} (edit ${String(argumen.old_string ?? "").length}→${String(argumen.new_string ?? "").length} char)`;
  else if (namaTool === "run_command") detail = `cmd: ${argumen.command}`;
  console.log("  " + label + (detail ? " " + cat(detail, C.abu) : ""));
}

async function mintaKonfirmasi(namaTool, argumen) {
  const autoApprove = process.env.OMNITERMUX_AUTO_APPROVE === "1" || process.env.OMNIROUTE_AUTO_APPROVE === "1";
  if (autoApprove) return true;
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

    // Penegakan mode PLAN (adopsi OpenCode2): hanya read_file & perintah aman
    let diizinkan = true;
    let alasanTolak = "";
    if (MODE_AKTIF === "plan") {
      if (namaTool === "write_file" || namaTool === "edit_file") {
        diizinkan = false;
        alasanTolak = "Diblokir mode PLAN: hanya boleh membaca, tidak menulis/mengedit file";
      } else if (namaTool === "run_command" && !perintahPlanDiizinkan(argumen.command)) {
        diizinkan = false;
        alasanTolak = `Diblokir mode PLAN: perintah di luar whitelist (hanya ls, cat, git status, dll.): ${String(argumen.command).slice(0, 80)}`;
      }
    }

    // Konfirmasi untuk tool yang mengubah state (write_file, edit_file, run_command)
    if (diizinkan && (namaTool === "write_file" || namaTool === "edit_file" || namaTool === "run_command")) {
      diizinkan = await mintaKonfirmasi(namaTool, argumen);
      if (!diizinkan) alasanTolak = "Ditolak oleh pengguna";
    }

    let hasilTool;
    if (!diizinkan) {
      hasilTool = { ok: false, error: alasanTolak || "Ditolak oleh pengguna" };
      console.log("  " + cat("⛔ " + (alasanTolak || "Ditolak oleh pengguna"), C.merah));
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

// Susun daftar tool sesuai mode agen.
// Mode PLAN: hanya read_file + run_command (dengan deskripsi whitelist),
// write_file/edit_file tidak dikirim ke model sama sekali.
function toolsUntukMode() {
  if (MODE_AKTIF !== "plan") return daftarTools;
  return daftarTools
    .filter((t) => t.function.name === "read_file" || t.function.name === "run_command")
    .map((t) => {
      if (t.function.name !== "run_command") return t;
      return {
        ...t,
        function: {
          ...t.function,
          description: "Menjalankan perintah shell HANYA yang read-only & aman (ls, cat, pwd, git status, git diff, git log, node --version, dll) — MODE PLAN melarang perintah yang mengubah sistem",
        },
      };
    });
}

async function kirimPesanDenganTool(riwayat, rl, lebar) {
  const url = `${BASE_URL}/chat/completions`;

  while (true) {
    let res;
    try {
      res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, messages: await susunPesanKeAPI(riwayat), tools: toolsUntukMode(), tool_choice: "auto", stream: false }),
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

/* ------------------------------------------------------------ Model Management */

async function ambilDaftarModelDariAPI(providerKey, apiKey, baseUrl) {
  const provider = DIRECT_PROVIDERS[providerKey];
  if (!provider?.modelsEndpoint) {
    throw new Error(`Provider tidak mendukung daftar model otomatis`);
  }

  const url = `${provider.baseUrl}/${provider.modelsEndpoint}`;
  let headers = { "Accept": "application/json" };

  if (provider.authType === "bearer") {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const urlWithKey = provider.authType === "query_key" 
      ? `${provider.baseUrl}/${provider.modelsEndpoint}?key=${encodeURIComponent(apiKey)}`
      : `${provider.baseUrl}/${provider.modelsEndpoint}`;

    const response = await fetch(urlWithKey, {
      headers,
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    
    let models = [];
    if (providerKey === "google") {
      models = data.models?.map(m => m.name.replace("models/", "")) || [];
    } else if (providerKey === "openrouter") {
      models = data.data?.map(m => m.id) || [];
    } else {
      models = data.data?.map(m => m.id) || [];
    }

    const chatModels = models.filter(m => 
      !m.includes("embedding") && 
      !m.includes("moderation") &&
      !m.includes("whisper") &&
      !m.includes("tts") &&
      !m.includes("dall-e")
    );

    return chatModels.length > 0 ? chatModels : models;
  } catch (err) {
    throw new Error(`Gagal mengambil daftar model: ${err.message}`);
  }
}

/* ------------------------------------------------------------ Slash Commands */

const UKURAN_HALAMAN = 20;

async function handleModelCommand(rl, lebar) {
  if (!PROVIDER_KEY || !DIRECT_PROVIDERS[PROVIDER_KEY]?.modelsEndpoint) {
    console.log(cat("  ⚠️  Perintah /model hanya tersedia untuk Direct Provider (bukan Gateway).", C.kuning));
    return;
  }

  const provider = DIRECT_PROVIDERS[PROVIDER_KEY];
  console.log(cat(`\n🔄 Mengambil daftar model dari ${provider.nama}...`, C.sian));

  let models;
  try {
    models = await ambilDaftarModelDariAPI(PROVIDER_KEY, API_KEY, BASE_URL);
  } catch (err) {
    console.log(cat(`\n❌ Gagal mengambil daftar model: ${err.message}`, C.merah));
    return;
  }

  if (models.length === 0) {
    console.log(cat("  Tidak ada model yang ditemukan.", C.kuning));
    return;
  }

  let offset = 0;
  let tampilSemua = models.length <= UKURAN_HALAMAN;

  const tampilkanDaftar = () => {
    if (tampilSemua) {
      console.log(cat(`\n📋 Semua model (${models.length}):`, C.putih, C.tebal));
    } else {
      const akhir = Math.min(offset + UKURAN_HALAMAN, models.length);
      const halaman = Math.floor(offset / UKURAN_HALAMAN) + 1;
      console.log(cat(`\n📋 Model ${offset + 1}–${akhir} dari ${models.length} (halaman ${halaman}):`, C.putih, C.tebal));
    }
    const bagian = tampilSemua ? models : models.slice(offset, offset + UKURAN_HALAMAN);
    bagian.forEach((m, i) => {
      const nomor = (tampilSemua ? i : offset + i) + 1;
      const mark = m === MODEL ? " " + cat("(aktif)", C.hijau) : "";
      console.log(`  ${cat(String(nomor).padStart(3), C.kuning)}. ${m}${mark}`);
    });
    if (!tampilSemua && models.length > UKURAN_HALAMAN) {
      console.log(cat("  Ketik 'next' untuk 20 berikutnya, atau 'all' untuk semua model.", C.abu));
    }
  };

  tampilkanDaftar();

  for (;;) {
    const hint = tampilSemua || models.length <= UKURAN_HALAMAN
      ? `nomor 1-${models.length} atau nama model`
      : `nomor 1-${models.length}, 'next', 'all', atau nama model`;
    const input = await tanyaRL(rl, `\nPilih model (${hint})`, "");
    const teks = input.trim();

    if (teks === "") {
      console.log(cat(`  Melewatkan perubahan. Model tetap: ${MODEL}`, C.abu));
      return;
    }

    const kecil = teks.toLowerCase();
    if (kecil === "next") {
      if (tampilSemua) {
        console.log(cat("  Semua model sudah ditampilkan.", C.abu));
      } else if (offset + UKURAN_HALAMAN >= models.length) {
        console.log(cat("  Sudah di halaman terakhir.", C.abu));
      } else {
        offset += UKURAN_HALAMAN;
        tampilkanDaftar();
      }
      continue;
    }
    if (kecil === "all") {
      if (tampilSemua) {
        console.log(cat("  Semua model sudah ditampilkan.", C.abu));
      } else {
        offset = 0;
        tampilSemua = true;
        tampilkanDaftar();
      }
      continue;
    }

    let modelBaru = null;
    const num = parseInt(teks, 10);
    if (!Number.isNaN(num) && num >= 1 && num <= models.length) {
      modelBaru = models[num - 1];
    } else if (models.includes(teks)) {
      modelBaru = teks;
    } else {
      const setuju = await tanyaYesNoRL(rl, `Model "${teks}" tidak dalam daftar. Tetap gunakan?`, false);
      if (setuju) modelBaru = teks;
      else console.log(cat("  Input tidak valid. Coba lagi.", C.abu));
    }

    if (modelBaru) {
      if (modelBaru === MODEL) {
        console.log(cat(`  Model sudah aktif: ${MODEL}`, C.abu));
        return;
      }
      try {
        const config = await bacaConfig();
        if (config) {
          config.model = modelBaru;
          await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
        }
        MODEL = modelBaru;
        SESI.modelAktif = MODEL;
        console.log(cat(`\n✅ Model berhasil diubah menjadi: ${modelBaru}`, C.hijau, C.tebal));
      } catch (err) {
        console.log(cat(`\n❌ Gagal menyimpan konfigurasi: ${err.message}`, C.merah));
      }
      return;
    }
  }
}

async function handleConfigCommand(rl, lebar) {
  const config = await bacaConfig();
  if (!config) {
    console.log(cat("  ⚠️  Konfigurasi tidak ditemukan.", C.kuning));
    return;
  }

  console.log();
  console.log(cat("╭─ Konfigurasi Saat Ini " + "─".repeat(Math.max(0, lebar - 23)) + "╮", C.abu));
  
  const providerInfo = config.tipe === "direct" && DIRECT_PROVIDERS[config.provider] 
    ? DIRECT_PROVIDERS[config.provider].nama 
    : config.tipe === "gateway" ? "Gateway/Proxy" : "Unknown";
  
  const apiKeyDisplay = config.apiKey 
    ? config.apiKey.slice(0, 6) + "..." + config.apiKey.slice(-4) 
    : "(kosong)";

  const rows = [
    ["Provider", providerInfo],
    ["Base URL", config.baseUrl],
    ["Model", config.model],
    ["API Key", apiKeyDisplay],
  ];

  rows.forEach(([label, value]) => {
    console.log(cat("│ ", C.abu) + cat(label.padEnd(12), C.abu) + cat("│ ", C.abu) + cat(value, C.putih) + " ".repeat(Math.max(1, lebar - 16 - lebarTeks(label) - lebarTeks(value))) + cat("│", C.abu));
  });
  console.log(cat("╰" + "─".repeat(Math.max(0, lebar - 2)) + "╯", C.abu));
  console.log();

  const action = await tanyaRL(rl, `Ketik 'edit' untuk mengubah konfigurasi (menjalankan setup ulang), atau tekan Enter untuk kembali: `, "");
  
  if (action.trim().toLowerCase() === "edit") {
    console.log();
    const config = await jalankanSetup();
    if (config) {
      BASE_URL = (config.baseUrl || "http://localhost:20128/v1").replace(/\/+$/, "");
      MODEL = config.model || "ALL-FREE";
      API_KEY = config.apiKey || "";
      PROVIDER_KEY = config.provider || "";
      SESI.modelAktif = MODEL;
      console.log(cat("\n✅ Konfigurasi diperbarui. Model aktif: " + MODEL, C.hijau));
    }
  }
}

function handleToolsCommand(lebar) {
  const tools = [
    ["read_file", "Membaca isi file di workspace", 'read_file({ "path": "file.txt" })'],
    ["write_file", "Menulis/membuat file di workspace", 'write_file({ "path": "file.txt", "content": "isi" })'],
    ["edit_file", "Mengganti teks spesifik (hemat token)", 'edit_file({ "path": "file.txt", "old_string": "a", "new_string": "b" })'],
    ["run_command", "Menjalankan perintah shell (timeout 10s)", 'run_command({ "command": "ls -la" })'],
  ];

  console.log();
  console.log(bingkaiAtas("AI Skills (Tools)", lebar));
  tools.forEach((row) => {
    const [name, desc, example] = row;
    console.log(cat("│ ", C.abu) + cat(name.padEnd(12), C.putih, C.tebal) + cat("│ ", C.abu) + cat(desc, C.putih) + " ".repeat(Math.max(1, lebar - 16 - lebarTeks(name) - lebarTeks(desc))) + cat("│", C.abu));
    console.log(cat("│ ", C.abu) + " ".repeat(14) + cat("Contoh: ", C.abu) + cat(example, C.sian) + " ".repeat(Math.max(1, lebar - 16 - lebarTeks(example))) + cat("│", C.abu));
  });
  console.log(bingkaiBawah(lebar));
  console.log();
}

async function handleModeCommand(teks) {
  const arg = teks.split(/\s+/).slice(1).join(" ").toLowerCase();

  if (arg === "build" || arg === "plan") {
    if (arg === MODE_AKTIF) {
      console.log(cat(`  Mode sudah aktif: ${MODE_AKTIF.toUpperCase()}`, C.abu));
      return;
    }
    MODE_AKTIF = arg;
    if (MODE_AKTIF === "plan") {
      console.log(cat("\n✅ Mode aktif: PLAN", C.kuning, C.tebal));
      console.log(cat("   AI hanya boleh membaca (read_file) dan perintah aman (ls, cat, git status, ...).", C.abu));
      console.log(cat("   Penulisan file & perintah berbahaya DIBLOKIR sistem.", C.abu));
    } else {
      console.log(cat("\n✅ Mode aktif: BUILD", C.hijau, C.tebal));
      console.log(cat("   AI bebas membaca, menulis, mengedit file, dan menjalankan perintah.", C.abu));
    }
    return;
  }

  if (arg === "") {
    console.log(cat(`\n🧭 Mode saat ini: ${MODE_AKTIF.toUpperCase()}`, C.putih, C.tebal));
    console.log(cat("   /mode plan  — mode aman: hanya baca (whitelist ls, cat, git status, dll)", C.abu));
    console.log(cat("   /mode build — mode penuh: baca + tulis + edit + eksekusi", C.abu));
    return;
  }

  console.log(cat(`\n✖ Mode tidak dikenal: "${arg}". Gunakan: /mode plan atau /mode build`, C.merah));
}

async function handleSkillsCommand(lebar) {
  console.log();
  let daftar = [];
  try {
    daftar = (await fs.readdir(SKILLS_DIR))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    daftar = [];
  }

  if (daftar.length === 0) {
    console.log(cat(`  Belum ada skill. Folder: ${SKILLS_DIR}`, C.kuning));
    console.log(cat("  Jalankan ulang aplikasi untuk membuat skill bawaan.", C.abu));
    return;
  }

  console.log(bingkaiAtas("Agent Skills", lebar, C.magenta));
  for (const nama of daftar) {
    let judul = "";
    try {
      const isi = await fs.readFile(path.join(SKILLS_DIR, `${nama}.md`), "utf-8");
      judul = isi.split("\n").find((b) => b.startsWith("# "))?.slice(2).trim() || "";
    } catch { /* file hilang saat dibaca → tampilkan tanpa judul */ }

    const aktif = activeSkill?.nama === nama;
    const label = `/${nama}`.padEnd(14);
    const teksPolos = label + judul + (aktif ? " (aktif)" : "");
    const pad = Math.max(1, lebar - 3 - lebarTeks(teksPolos));
    console.log(
      cat("│ ", C.abu) +
      cat(label, C.kuning) +
      cat(judul, C.putih) +
      (aktif ? cat(" (aktif)", C.hijau) : "") +
      " ".repeat(pad) +
      cat("│", C.abu)
    );
  }
  console.log(bingkaiBawah(lebar, C.magenta));
  console.log(cat(`  Aktifkan: ${SKILL_TERSEDIA.map((s) => "/" + s).join(", ")} · /clear-skill untuk mematikan`, C.abu));
}

async function handleSoulCommand(arg, lebar) {
  if (arg === "edit") {
    console.log(cat(`\n  Membuka nano: ${SOUL_FILE}`, C.abu));
    const sukses = await new Promise((resolve) => {
      const anak = spawn("nano", [SOUL_FILE], { stdio: "inherit" });
      anak.on("error", (err) => {
        console.log(cat(`  ✖ Gagal membuka nano: ${err.message}`, C.merah));
        console.log(cat(`    Edit manual dengan editor lain: ${SOUL_FILE}`, C.kuning));
        resolve(false);
      });
      anak.on("exit", () => resolve(true));
    });
    if (sukses) {
      await muatSOUL();
      console.log(cat("  ✅ SOUL dimuat ulang — kepribadian baru aktif untuk pesan berikutnya.", C.hijau));
    }
    return;
  }

  // Tampilkan isi SOUL.md (dibaca segar dari disk)
  let isi = "";
  try { isi = await fs.readFile(SOUL_FILE, "utf-8"); } catch { isi = SOUL_TEKS; }
  console.log();
  console.log(bingkaiAtas("SOUL — Identitas & Kepribadian", lebar, C.magenta));
  cetakIsiBingkai(siapkanIsi(isi.trim() || "(file kosong)", Math.max(20, lebar - 4)), lebar - 3, C.magenta);
  console.log(bingkaiBawah(lebar, C.magenta));
  console.log(cat(`  Ubah dengan /soul edit (nano) · file: ${SOUL_FILE}`, C.abu));
}

function handleClearCommand() {
  // ANSI escape code untuk clear screen
  process.stdout.write("\x1b[2J\x1b[0f");
}

async function handleHelpCommand(lebar) {
  const categories = {
    "Chat & Session": [
      ["/help", "Tampilkan bantuan ini"],
      ["/stats", "Tampilkan statistik sesi (token, biaya, durasi)"],
      ["/compact", "Minta AI merangkum percakapan untuk hemat konteks"],
      ["/reset", "Kosongkan riwayat percakapan"],
      ["/clear", "Bersihkan layar terminal"],
      ["exit", "Keluar (juga: quit, /exit, atau Ctrl+C)"],
    ],
    "Konfigurasi & Alat": [
      ["/mode", "Ganti mode agen: /mode plan (hanya baca) atau /mode build (penuh)"],
      ["/model", "Pilih model AI interaktif (Direct Provider)"],
      ["/config", "Lihat & ubah konfigurasi (provider, model, API key)"],
      ["/tools", "Lihat daftar AI Skills (tools) yang tersedia"],
      ["/remember", "Simpan fakta ke memori persisten (/remember <fakta>)"],
      ["/recall", "Tampilkan semua fakta yang tersimpan di memori"],
      ["/soul", "Lihat identitas AI (SOUL.md); /soul edit untuk mengubah via nano"],
      ["/help", "Tampilkan bantuan ini"],
    ],
    "Agent Skills": [
      ["/skills", "Daftar skill yang tersedia di folder skills"],
      ["/grill-me", "Interogasi dulu: tanya detail proyek sebelum menulis kode"],
      ["/tdd", "Ikuti alur Test-Driven Development (Red-Green-Refactor)"],
      ["/code-review", "Review kode yang baru ditulis sebelum menyatakan selesai"],
      ["/clear-skill", "Matikan skill yang sedang aktif"],
    ],
  };

  console.log();
  console.log(bingkaiAtas("Bantuan — Perintah Tersedia", lebar));

  for (const [category, commands] of Object.entries(categories)) {
    console.log(cat("│ " + category, C.putih, C.tebal) + " ".repeat(Math.max(1, lebar - 2 - lebarTeks(category))) + cat("│", C.abu));
    commands.forEach(([cmd, desc]) => {
      console.log(cat("│   ", C.abu) + cat(cmd.padEnd(14), C.kuning) + cat("— ", C.abu) + cat(desc, C.putih) + " ".repeat(Math.max(1, lebar - 18 - lebarTeks(cmd) - lebarTeks(desc))) + cat("│", C.abu));
    });
    console.log(cat("├" + "─".repeat(Math.max(0, lebar - 2)) + "┤", C.abu));
  }
  console.log(cat("╰" + "─".repeat(Math.max(0, lebar - 2)) + "╯", C.abu));
  console.log();
}

function handleModelNotFoundError(modelName) {
  console.log(cat(`\n❌ Model '${modelName}' tidak ditemukan di server.`, C.merah));
  console.log(cat("   Ketik /model untuk memilih model lain yang tersedia.", C.kuning));
}

/* ------------------------------------------------------------ Readline helpers untuk slash commands */

function tanyaRL(rl, pertanyaan, defaultVal = "") {
  return new Promise((resolve) => {
    if (!stdout.isTTY) { resolve(defaultVal); return; }
    const prompt = defaultVal ? `${pertanyaan} [${defaultVal}]: ` : `${pertanyaan}: `;
    try {
      rl.question(prompt, (input) => {
        resolve((input || "").trim() || defaultVal);
      });
    } catch (err) {
      if (err && err.code === "ERR_USE_AFTER_CLOSE") resolve(defaultVal);
      else throw err;
    }
  });
}

function tanyaYesNoRL(rl, pertanyaan, defaultYes = true) {
  return new Promise((resolve) => {
    if (!stdout.isTTY) { resolve(defaultYes); return; }
    const hint = defaultYes ? "Y/n" : "y/N";
    try {
      rl.question(`${pertanyaan} [${hint}]: `, (jawab) => {
        const t = (jawab || "").trim().toLowerCase();
        if (t === "") resolve(defaultYes);
        else resolve(t === "y" || t === "yes");
      });
    } catch (err) {
      if (err && err.code === "ERR_USE_AFTER_CLOSE") resolve(defaultYes);
      else throw err;
    }
  });
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
      body: JSON.stringify({ model: MODEL, messages: [...(await susunPesanKeAPI(riwayat)), { role: "user", content: prompt }], stream: false, max_tokens: 500 }),
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
  const isi = hasil.teks.trim() === "" ? "(balasan kosong)" : hasil.teks;
  console.log(); // jarak kosong di atas balasan AI
  console.log(bingkaiAtas(`AI · ${hasil.model}`, lebar, C.abu));
  cetakIsiBingkai(siapkanIsi(isi, dalam), lebar - 3, C.abu);
  console.log(bingkaiBawah(lebar, C.abu));
  console.log(); // jarak kosong di bawah balasan AI
}

// Hapus baris echo readline agar pesan user hanya tampil di dalam bingkai.
function hapusEchoUser(teks) {
  if (!stdout.isTTY) return;
  const kolom = stdout.columns || Number(process.env.COLUMNS) || 80;
  const lebarEcho = 9 + lebarTeks(teks); // "  USER > "
  const jumlahBaris = Math.max(1, Math.ceil(lebarEcho / kolom));
  let keluaran = "\r\x1b[2K";
  for (let i = 0; i < jumlahBaris; i += 1) keluaran += "\x1b[1A\r\x1b[2K";
  try { stdout.write(keluaran); } catch { /* terminal aneh → biarkan echo tampil */ }
}

// Pesan user dalam bingkai sendiri (sudut membulat, aksen sian = "info").
function cetakPesanUser(teks, lebar) {
  const dalam = Math.max(24, lebar - 4);
  console.log(); // jarak kosong di atas pesan user
  console.log(bingkaiAtas("USER", lebar, C.sian));
  cetakIsiBingkai(siapkanIsi(teks, dalam), lebar - 3, C.sian);
  console.log(bingkaiBawah(lebar, C.sian));
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
  if (status === 404) return `Model "${MODEL}" tidak ditemukan di server (HTTP 404).${ekor}`;
  if (status === 429) return `Kena rate limit (HTTP 429). Tunggu sebentar lalu coba lagi.${ekor}`;
  if (status >= 500) return `Server bermasalah (HTTP ${status}).${ekor}`;
  return `Permintaan ditolak (HTTP ${status}).${ekor}`;
}

/* ------------------------------------------------------------ main */

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

/* ------------------------------------------------- memori persisten (Hermes Agent) */

const MEMORY_FILE = path.join(CONFIG_DIR, "memory.json");

async function muatMemori() {
  try {
    const data = await fs.readFile(MEMORY_FILE, "utf-8");
    const json = JSON.parse(data);
    return Array.isArray(json.fakta) ? json.fakta : [];
  } catch {
    return []; // file belum ada atau rusak → anggap kosong, jangan crash
  }
}

async function tambahFakta(teks) {
  const fakta = await muatMemori();
  fakta.push({ teks, waktu: new Date().toISOString() });
  await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
  await fs.writeFile(MEMORY_FILE, JSON.stringify({ versi: 1, fakta }, null, 2), "utf-8");
  return fakta;
}

/* ------------------------------------------------- SOUL.md (Hermes Agent) */

const SOUL_FILE = path.join(CONFIG_DIR, "SOUL.md");
let SOUL_TEKS = "";

const SOUL_BAWAAN = `# SOUL — Kepribadian omnitermux

Anda adalah asisten AI omnitermux yang membantu, ramah, dan ringkas.
Anda berjalan di terminal Termux di perangkat Android pengguna.

## Kepribadian
- Ramah dan sopan, tapi langsung ke inti — tanpa basa-basi berlebihan.
- Ringkas: jawab secukupnya; gunakan poin/bullet untuk langkah teknis.
- Jujur: jika tidak tahu atau belum yakin, katakan terus; jangan mengarang.
- Proaktif: tawarkan langkah berikutnya yang wajar tanpa bertele-tele.

## Konteks teknis
- Anda berjalan di terminal: format jawaban harus ramah-terminal (markdown ringan, tanpa HTML).
- Gunakan Bahasa Indonesia untuk percakapan, kecuali user memilih bahasa lain.
- Anda punya akses tool (baca/tulis/edit file, jalankan perintah) di dalam folder workspace — gunakan langsung saat relevan.
`;

// Baca SOUL.md setiap aplikasi dimuat; buat file bawaan jika belum ada
async function muatSOUL() {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    try {
      await fs.access(SOUL_FILE);
    } catch {
      await fs.writeFile(SOUL_FILE, SOUL_BAWAAN, "utf-8");
    }
    SOUL_TEKS = await fs.readFile(SOUL_FILE, "utf-8");
  } catch {
    SOUL_TEKS = ""; // gagal baca → lanjut tanpa identitas khusus
  }
}

/* --------------------------- perakit system message (urutan prioritas) */
// 1. SOUL.md (identitas) → 2. Skill aktif → 3. Memori persisten → 4. Mode agen
async function susunSystemPesan() {
  const bagian = [];

  // 1. Identitas & kepribadian — paling atas
  const soul = (SOUL_TEKS || "").trim();
  bagian.push(soul ||
    "Anda adalah asisten AI omnitermux yang membantu, ramah, dan ringkas. Berjalan di terminal Termux.");

  // 2. Instruksi skill aktif (jika ada)
  if (activeSkill) {
    bagian.push(
      `=== SKILL AKTIF: ${activeSkill.nama} ===\n` +
      `Ikuti instruksi skill berikut untuk semua permintaan selama skill ini aktif:\n` +
      activeSkill.isi.trim()
    );
  }

  // 3. Memori persisten (fakta yang diingat)
  const fakta = await muatMemori();
  if (fakta.length > 0) {
    bagian.push(
      "=== MEMORI PERSISTEN ===\n" +
      "Fakta penting tentang user (gunakan sebagai konteks, jangan diucapkan ulang kecuali diminta):\n" +
      fakta.map((f) => `- ${f.teks}`).join("\n")
    );
  }

  // 4. Mode agen beserta whitelist — paling bawah
  if (MODE_AKTIF === "plan") {
    bagian.push(
      "=== MODE AGEN: PLAN (read-only) ===\n" +
      `Kamu HANYA boleh membaca (read_file) dan perintah shell dari whitelist berikut: ${PLAN_WHITELIST.join(", ")}.\n` +
      "Dilarang menulis/mengedit file atau menjalankan perintah di luar whitelist — sistem akan memblokirnya.\n" +
      "GUNAKAN TOOL LANGSUNG tanpa menanyakan izin via teks; konfirmasi ditangani sistem. Bahasa Indonesia."
    );
  } else {
    bagian.push(
      "=== MODE AGEN: BUILD ===\n" +
      "Kamu boleh membaca, menulis, mengedit file, dan menjalankan perintah (tool: read_file, write_file, edit_file, run_command) dengan konfirmasi pengguna.\n" +
      "GUNAKAN TOOL LANGSUNG tanpa menanyakan izin via teks; konfirmasi ditangani sistem. Bahasa Indonesia."
    );
  }

  return bagian.join("\n\n");
}

/* -------------------------------------------- agent skills (Matt Pocock) */

const SKILLS_DIR = path.join(CONFIG_DIR, "skills");

// Skill bawaan — ditulis ke disk hanya jika file belum ada (editan user dihormati)
const SKILL_BAWAAN = {
  "grill-me": `# Grill Me — Interogasi Sebelum Kode

Kamu dalam mode GRILL ME. Bertindaklah sebagai interogator yang ramah namun tajam, terinspirasi teknik "grilling" Matt Pocock: menggali keputusan desain lewat pertanyaan sebelum satu baris kode ditulis.

## Aturan main
1. **JANGAN menulis kode** sampai semua pertanyaan penting terjawab dan kamu merangkum keputusannya.
2. Ajukan **maksimal 3 pertanyaan** per giliran — bukan daftar panjang.
3. Urutkan prioritas: (a) tujuan & kriteria sukses, (b) constraint & asumsi, (c) edge case & error handling, (d) strategi testing, (e) scope / apa yang TIDAK dikerjakan.
4. **Tantang asumsi lemah.** Jika jawaban user ambigu, tunjukkan 2-3 alternatif beserta trade-off-nya, lalu minta memilih.
5. Setelah semua jelas: rangkum keputusan dalam daftar pendek, minta konfirmasi "lanjut?", dan BARU mulai menulis kode.
6. Berhenti menggali ketika jawaban sudah cukup untuk implementasi — jangan berlebihan.

## Format pertanyaan
- Spesifik, satu topik per pertanyaan.
- Sertakan konsekuensi: "Kalau X, apa yang terjadi saat ...?"
- Jawankan dulu keputusan yang paling mahal dibatalkan (irreversible decisions first).
`,
  "tdd": `# TDD — Red · Green · Refactor

Kamu dalam mode TDD. Ikuti siklus ketat Test-Driven Development untuk setiap perilaku baru.

## Siklus wajib
1. **RED** — Tulis SATU test yang mewakili perilaku berikutnya. Jalankan dan pastikan **GAGAL** dengan alasan yang benar (bukan error import/konfigurasi). Jika test langsung lulus, test-nya belum cukup spesifik — perbaiki test-nya.
2. **GREEN** — Tulis implementasi **minimum** agar test lulus. Jangan menulis kode untuk kasus yang belum ditest. Jalankan seluruh test: harus lulus semua.
3. **REFACTOR** — Rapikan kode dan duplikasi tanpa mengubah perilaku. Jalankan ulang test setelah setiap perubahan.

## Aturan
- Tidak ada implementasi sebelum test gagal (RED dulu, selalu).
- Satu perilaku per siklus — jangan menumpuk banyak test sekaligus.
- Test harus menutupi: happy path, edge case, dan error/invalid input.
- Sebutkan status setiap langkah: \`RED → ...\`, \`GREEN → ...\`, \`REFACTOR → ...\`.
- Jika tergoda menulis kode tanpa test, berhenti dan tulis test-nya dulu.
`,
  "code-review": `# Code Review — Review Kode yang Baru Ditulis

Kamu dalam mode CODE REVIEW. Setelah kode selesai ditulis (atau saat user minta review), lakukan review mandiri sebelum menyatakan selesai.

## Checklist
1. **Correctness** — Logika benar di semua jalur? Ada bug tersembunyi?
2. **Edge case** — Input kosong, null/undefined, angka negatif, string panjang, file hilang?
3. **Error handling** — Error ditangani dan pesannya membantu? Ada yang ditelan diam-diam?
4. **Naming & readability** — Nama variabel/fungsi jujur tentang isinya? Ada fungsi terlalu panjang?
5. **Duplikasi** — Kode berulang yang bisa diekstrak?
6. **Security** — Input user dipercaya mentah-mentah? Path/command bisa disalahgunakan?
7. **Tests** — Ada test untuk perilaku baru? Test-nya benar-benar menguji (bukan lulus palsu)?
8. **Scope** — Perubahan sesuai permintaan? Ada perubahan yang tidak diminta?

## Format laporan
- 🔴 **Blocking** — harus diperbaiki sebelum selesai.
- 🟡 **Suggestion** — sebaiknya diperbaiki, beri alasan singkat.
- 🟢 **Nit** — preferensi gaya, boleh diabaikan.
- Akhiri dengan **verdict**: \`LULUS\` atau \`PERLU PERBAIKAN\` beserta daftar perbaikan konkret (lokasi + apa yang diubah).
`,
};

async function siapkanSkills() {
  try {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    for (const [nama, isi] of Object.entries(SKILL_BAWAAN)) {
      const file = path.join(SKILLS_DIR, `${nama}.md`);
      try {
        await fs.access(file); // sudah ada → jangan timpa
      } catch {
        await fs.writeFile(file, isi, "utf-8");
      }
    }
  } catch {
    // biarkan gagal senyap; /skills akan memberi pesan jika kosong
  }
}

async function bacaSkill(nama) {
  if (!SKILL_TERSEDIA.includes(nama)) throw new Error(`Skill tidak dikenal: ${nama}`);
  const file = path.join(SKILLS_DIR, `${nama}.md`);
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    throw new Error(`File skill tidak ditemukan: ${file} (jalankan ulang aplikasi untuk membuat skill bawaan)`);
  }
}

async function aktifkanSkill(nama) {
  const isi = await bacaSkill(nama);
  activeSkill = { nama, isi };
  return activeSkill;
}

// Susun messages untuk request: system message SELALU disusun ulang dari
// komponen terbaru (SOUL → skill → memori → mode) dan diletakkan paling atas.
// Riwayat ASLI tidak disentuh — hanya salinan, agar tidak ada yang menumpuk.
async function susunPesanKeAPI(riwayat) {
  const salinan = riwayat.map((m) => ({ ...m }));
  const sistem = { role: "system", content: await susunSystemPesan() };
  const indeksSistem = salinan.findIndex((m) => m.role === "system");
  if (indeksSistem >= 0) salinan[indeksSistem] = sistem;
  else salinan.unshift(sistem);
  return salinan;
}

async function main() {
  // Siapkan SOUL.md, folder & skill bawaan sebelum sesi dimulai
  await muatSOUL();
  await siapkanSkills();
  // 1. Muat konfigurasi
  let config = await bacaConfig();
  if (!config) {
    console.log(`\n${cat("⚙️  Konfigurasi tidak ditemukan.", C.kuning)}`);
    console.log(`${cat("   Menjalankan setup interaktif...", C.abu)}\n`);
    config = await jalankanSetup();
  }

  // 2. Set variabel global dari config
  BASE_URL = (config.baseUrl || "http://localhost:20128/v1").replace(/\/+$/, "");
  MODEL = config.model || "ALL-FREE";
  API_KEY = config.apiKey || "";
  PROVIDER_KEY = config.provider || "";

  if (!API_KEY) {
    console.error(cat("✖  API Key tidak ditemukan di konfigurasi.", C.merah));
    console.error(`  Jalankan: ${cat("rm ~/.config/omnitermux/config.json", C.kuning)} untuk setup ulang.`);
    process.exitCode = 1;
    return;
  }

  const lebar = lebarTampilan();

  // Inisialisasi sesi setelah config dimuat
  SESI = {
    mulai: Date.now(),
    tokenTotal: 0,
    modelAktif: MODEL,
    pesanDikirim: 0,
    pesanDiterima: 0,
  };

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: stdout.isTTY,
  });
  const riwayat = []; // system message disusun ulang per request oleh susunPesanKeAPI()
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

    // Slash commands
    if (teks === "/help") { console.log(); await handleHelpCommand(lebar); tanya(); continue; }
    if (teks === "/stats") { console.log(); cetakStatistik(lebar); tanya(); continue; }
    if (teks === "/model") { console.log(); await handleModelCommand(rl, lebar); tanya(); continue; }
    if (teks === "/config") { console.log(); await handleConfigCommand(rl, lebar); tanya(); continue; }
    if (teks === "/tools") { console.log(); handleToolsCommand(lebar); tanya(); continue; }
    if (teks === "/mode" || teks.startsWith("/mode ")) { console.log(); await handleModeCommand(teks); tanya(); continue; }
    if (teks === "/remember" || teks.startsWith("/remember ")) {
      console.log();
      const fakta = teks.slice("/remember".length).trim();
      if (!fakta) {
        console.log(cat("  ℹ️  Gunakan: /remember <fakta> — contoh: /remember Saya suka kopi dingin", C.kuning));
      } else {
        await tambahFakta(fakta);
        const total = (await muatMemori()).length;
        console.log(cat(`  🧠 Tersimpan ke memori: ${fakta}`, C.hijau));
        console.log(cat(`     Total fakta: ${total} (lihat dengan /recall)`, C.abu));
      }
      console.log(); tanya(); continue;
    }
    if (teks === "/recall") {
      console.log();
      const fakta = await muatMemori();
      if (fakta.length === 0) {
        console.log(cat("  🧠 Belum ada fakta tersimpan. Tambah dengan: /remember <fakta>", C.kuning));
      } else {
        console.log(bingkaiAtas(`Memori (${fakta.length} fakta)`, lebar, C.sian));
        fakta.forEach((f, i) => {
          const baris = `${i + 1}. ${f.teks}`;
          for (const b of bungkus(baris, Math.max(20, lebar - 3))) {
            console.log(cat("│ ", C.abu) + cat(b, C.putih) + " ".repeat(Math.max(1, lebar - 3 - lebarTeks(b))) + cat("│", C.abu));
          }
        });
        console.log(bingkaiBawah(lebar, C.sian));
      }
      console.log(); tanya(); continue;
    }
    if (teks === "/soul" || teks.startsWith("/soul ")) {
      console.log();
      await handleSoulCommand(teks.split(/\s+/)[1] || "", lebar);
      tanya(); continue;
    }
    if (teks === "/skills") { console.log(); await handleSkillsCommand(lebar); tanya(); continue; }
    if (teks === "/clear-skill") {
      console.log();
      if (activeSkill) {
        console.log(cat(`  🎯 Skill dimatikan: ${activeSkill.nama}`, C.abu));
        activeSkill = null;
      } else {
        console.log(cat("  Tidak ada skill yang aktif.", C.abu));
      }
      console.log(); tanya(); continue;
    }
    if (teks.startsWith("/") && SKILL_TERSEDIA.includes(teks.slice(1))) {
      const nama = teks.slice(1);
      console.log();
      try {
        const skill = await aktifkanSkill(nama);
        const judul = skill.isi.split("\n").find((b) => b.startsWith("# "))?.slice(2).trim() || nama;
        console.log(cat(`  🎯 Skill aktif: ${nama}`, C.magenta, C.tebal));
        console.log(cat(`     ${judul}`, C.putih));
        console.log(cat("     Aktif untuk semua pesan berikutnya · /clear-skill untuk mematikan", C.abu));
      } catch (err) {
        console.log(cat(`  ✖ ${err.message}`, C.merah));
      }
      console.log(); tanya(); continue;
    }
    if (teks === "/clear") { handleClearCommand(); tanya(); continue; }
    if (teks === "/reset") {
      riwayat.length = 0;
      SESI.tokenTotal = 0; SESI.pesanDikirim = 0; SESI.pesanDiterima = 0;
      console.log("  " + cat("Riwayat percakapan dikosongkan.", C.abu));
      console.log(); tanya(); continue;
    }
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
    hapusEchoUser(teks);
    cetakPesanUser(teks, lebar);
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
      // Handle 404 model not found
      if (err.message.includes("404") && err.message.includes("Model")) {
        handleModelNotFoundError(MODEL);
      } else {
        cetakGalat("Gagal", err.message, lebar);
      }
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

if (require.main === module) {
  main().catch((err) => { console.error("Terjadi kesalahan tak terduga:", err); process.exitCode = 1; });
}

module.exports = { kirimPesanDenganTool, pesanHTTP, pesanJaringan, bungkus, lebarTampilan, lebarTeks, siapkanIsi, formatTabel, warnaiKode, formatTokenSingkat, perintahPlanDiizinkan, toolsUntukMode, muatMemori, siapkanSkills, susunSystemPesan, susunPesanKeAPI, aktifkanSkill, muatSOUL, SKILLS_DIR, SOUL_FILE };