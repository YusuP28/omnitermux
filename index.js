#!/usr/bin/env node
"use strict";

/**
 * omnitermux — CLI chat modern dengan Tool Calling + Multi-Provider support.
 * Hanya modul bawaan Node.js, tanpa dependensi eksternal.
 */

const readline = require("node:readline");
const { stdin, stdout } = require("node:process");
const { daftarTools, eksekusiTool } = require("./tools.js");
const { bacaConfig, jalankanSetup, CONFIG_FILE, DIRECT_PROVIDERS } = require("./setup.js");

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

// batas lebar tampilan agar nyaman di layar HP (bisa dioverride lewat env)
const LEBAR_MAKS = 70;
const LEBAR_MIN = 40;

// versi aplikasi
const VERSI = "0.5.0";

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
  console.log(cat("┌─ Konfigurasi Saat Ini " + "─".repeat(Math.max(0, lebar - 23)) + "┐", C.abu));
  
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
  console.log(cat("└" + "─".repeat(Math.max(0, lebar - 2)) + "┘", C.abu));
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
      ["/model", "Pilih model AI interaktif (Direct Provider)"],
      ["/config", "Lihat & ubah konfigurasi (provider, model, API key)"],
      ["/tools", "Lihat daftar AI Skills (tools) yang tersedia"],
      ["/help", "Tampilkan bantuan ini"],
    ],
  };

  console.log();
  console.log(bingkaiAtas("Bantuan — Perintah Tersedia", lebar));

  for (const [category, commands] of Object.entries(categories)) {
    console.log(cat("│ " + category, C.putih, C.tebal) + " ".repeat(Math.max(1, lebar - 2 - lebarTeks(category))) + cat("│", C.abu));
    commands.forEach(([cmd, desc]) => {
      console.log(cat("│   ", C.abu) + cat(cmd.padEnd(10), C.kuning) + cat("— ", C.abu) + cat(desc, C.putih) + " ".repeat(Math.max(1, lebar - 14 - lebarTeks(cmd) - lebarTeks(desc))) + cat("│", C.abu));
    });
    console.log(cat("├" + "─".repeat(Math.max(0, lebar - 2)) + "┤", C.abu));
  }
  console.log(cat("└" + "─".repeat(Math.max(0, lebar - 2)) + "┘", C.abu));
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

/* ------------------------------------------------------------ token & status */

function hitungTokenPerkiraan(teks) { return Math.ceil(String(teks).length / 3.5); }

function formatDurasi(ms) { const d = Math.floor(ms/1000); const m=Math.floor(d/60); const s=d%60; return m>0?`${m}m ${s}s`:`${s}s`; }
function hitungBiayaPerkiraan(t) { return "$0.00"; }

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
  if (status === 404) return `Model "${MODEL}" tidak ditemukan di server (HTTP 404).${ekor}`;
  if (status === 429) return `Kena rate limit (HTTP 429). Tunggu sebentar lalu coba lagi.${ekor}`;
  if (status >= 500) return `Server bermasalah (HTTP ${status}).${ekor}`;
  return `Permintaan ditolak (HTTP ${status}).${ekor}`;
}

/* ------------------------------------------------------------ main */

const fs = require("node:fs/promises");
const path = require("node:path");

async function main() {
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

    // Slash commands
    if (teks === "/help") { console.log(); await handleHelpCommand(lebar); tanya(); continue; }
    if (teks === "/stats") { console.log(); cetakStatistik(lebar); tanya(); continue; }
    if (teks === "/model") { console.log(); await handleModelCommand(rl, lebar); tanya(); continue; }
    if (teks === "/config") { console.log(); await handleConfigCommand(rl, lebar); tanya(); continue; }
    if (teks === "/tools") { console.log(); handleToolsCommand(lebar); tanya(); continue; }
    if (teks === "/clear") { handleClearCommand(); tanya(); continue; }
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

module.exports = { kirimPesanDenganTool, pesanHTTP, pesanJaringan, bungkus, lebarTampilan, lebarTeks, siapkanIsi, formatTabel };