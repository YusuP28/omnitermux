#!/usr/bin/env node
"use strict";

/**
 * omnitermux — CLI chat sederhana lewat OmniRoute (Combo ALL-FREE).
 * Hanya memakai modul bawaan Node.js, tanpa dependensi eksternal.
 */

const readline = require("node:readline");
const { stdin, stdout } = require("node:process");

const BASE_URL = (process.env.OMNIROUTE_BASE_URL || "http://localhost:20128/v1").replace(/\/+$/, "");
const MODEL = process.env.OMNIROUTE_MODEL || "ALL-FREE";
const API_KEY = process.env.OMNIROUTE_API_KEY;
const TIMEOUT_MS = 120_000;

// metadata combo mendeklarasikan context 4096, jadi riwayat sengaja dibatasi
const MAKS_PESAN = 20;

const BANTUAN = [
  "Perintah:",
  "  /help    tampilkan bantuan ini",
  "  /reset   kosongkan riwayat percakapan",
  "  /model   tampilkan model & endpoint yang dipakai",
  "  exit     keluar (juga: quit, /exit, atau Ctrl+C)",
].join("\n");

const STATUS = "AI    > memproses...";

function gagal(pesan) {
  throw new Error(pesan);
}

/** Ubah error jaringan menjadi pesan yang bisa ditindaklanjuti. */
function pesanJaringan(err, url) {
  if (err && err.name === "TimeoutError") {
    return `Server tidak merespons dalam ${TIMEOUT_MS / 1000} detik (${url}).`;
  }
  const kode = err && err.cause && err.cause.code;
  if (kode === "ECONNREFUSED") {
    return `Tidak bisa terhubung ke ${url}.\n  Server OmniRoute sepertinya mati. Coba jalankan: omnirouter start`;
  }
  if (kode === "ENOTFOUND" || kode === "EAI_AGAIN") {
    return `Alamat ${url} tidak bisa dijangkau (DNS gagal).`;
  }
  return `Gagal menghubungi ${url}: ${(err && err.message) || String(err)}`;
}

/** Ubah status HTTP non-2xx menjadi pesan yang jelas. */
function pesanHTTP(status, detail) {
  const ekor = detail ? `\n  Detail dari server: ${detail}` : "";
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

/** Kirim seluruh riwayat percakapan, kembalikan balasan asisten. */
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

async function main() {
  if (!API_KEY) {
    console.error("OMNIROUTE_API_KEY belum diset.");
    console.error("  Contoh: export OMNIROUTE_API_KEY=sk-...");
    process.exitCode = 1;
    return;
  }

  console.log("omnitermux — CLI chat via OmniRoute");
  console.log(`Endpoint : ${BASE_URL}`);
  console.log(`Model    : ${MODEL}`);
  console.log("Ketik /help untuk bantuan, atau exit untuk keluar.\n");

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
    try {
      rl.prompt();
    } catch (err) {
      // interface sudah tertutup (mis. semua input habis) — tidak perlu prompt
      if (err && err.code !== "ERR_USE_AFTER_CLOSE") throw err;
    }
  };

  rl.setPrompt("Anda > ");
  rl.prompt();

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
      console.log(BANTUAN + "\n");
      tanya();
      continue;
    }
    if (teks === "/model") {
      console.log(`${MODEL} @ ${BASE_URL}\n`);
      tanya();
      continue;
    }
    if (teks === "/reset") {
      riwayat.length = 0;
      console.log("Riwayat percakapan dikosongkan.\n");
      tanya();
      continue;
    }

    riwayat.push({ role: "user", content: teks });
    potongRiwayat(riwayat);

    stdout.write(STATUS);
    let hasil;
    try {
      hasil = await kirimPesan(riwayat);
    } catch (err) {
      stdout.write("\r" + " ".repeat(STATUS.length) + "\r");
      console.error(`AI    > GAGAL: ${err.message}\n`);
      // pesan yang gagal terkirim tidak disimpan di riwayat
      riwayat.pop();
      tanya();
      continue;
    }
    stdout.write("\r" + " ".repeat(STATUS.length) + "\r");

    riwayat.push({ role: "assistant", content: hasil.teks });
    potongRiwayat(riwayat);

    const indent = " ".repeat(8);
    const isi = hasil.teks === "" ? "(balasan kosong)" : hasil.teks;
    console.log("AI    > " + isi.split("\n").join("\n" + indent));
    console.log(indent + `[${hasil.model}]\n`);

    tanya();
  }

  console.log(keluar ? "Sampai jumpa." : "\nSampai jumpa.");
}

main().catch((err) => {
  console.error("Terjadi kesalahan tak terduga:", err);
  process.exitCode = 1;
});

module.exports = { kirimPesan, pesanHTTP, pesanJaringan };
