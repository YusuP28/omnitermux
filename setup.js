"use strict";

/**
 * setup.js — Onboarding & konfigurasi untuk omnitermux.
 * Hanya modul bawaan Node.js.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { stdin, stdout } = require("node:process");

/* ------------------------------------------------------------ konstanta */

const CONFIG_DIR = path.join(process.env.HOME || "/data/data/com.termux/files/home", ".config", "omnitermux");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/* ------------------------------------------------------------ daftar provider direct */

const DIRECT_PROVIDERS = {
  nvidia: {
    nama: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelDefault: "nvidia/nemotron-3-ultra-550b-a55b",
  },
  openrouter: {
    nama: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    modelDefault: "openrouter/auto",
  },
  groq: {
    nama: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    modelDefault: "llama-3.1-70b-versatile",
  },
  google: {
    nama: "Google AI (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelDefault: "gemini-1.5-flash",
  },
  anthropic: {
    nama: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    modelDefault: "claude-3-5-sonnet-20241022",
  },
  openai: {
    nama: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    modelDefault: "gpt-4o-mini",
  },
};

/* ------------------------------------------------------------ utilitas */

function cat(teks) { return teks; } // tanpa warna di setup

function tanya(pertanyaan, defaultVal = "") {
  return new Promise((resolve) => {
    const prompt = defaultVal ? `${pertanyaan} [${defaultVal}]: ` : `${pertanyaan}: `;
    stdout.write(prompt);
    stdin.once("data", (data) => {
      const input = data.toString().trim();
      resolve(input || defaultVal);
    });
  });
}

function tanyaYesNo(pertanyaan, defaultYes = true) {
  return new Promise((resolve) => {
    const hint = defaultYes ? "Y/n" : "y/N";
    stdout.write(`${pertanyaan} [${hint}]: `);
    stdin.once("data", (data) => {
      const input = data.toString().trim().toLowerCase();
      if (!input) resolve(defaultYes);
      else resolve(input === "y" || input === "yes");
    });
  });
}

/* ------------------------------------------------------------ onboarding utama */

async function jalankanSetup() {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║          🚀  omnitermux — Konfigurasi Awal                ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");

  console.log("Pilih tipe koneksi:");
  console.log("  1. Direct Provider (API Key langsung ke NVIDIA, OpenRouter, Groq, dll)");
  console.log("  2. Gateway / Proxy (OmniRoute, 9Router, LiteLLM, LiteLLM, dll)\n");

  const tipe = await tanya("Pilihan (1/2)", "1");

  let config = { versi: 1 };

  if (tipe === "1") {
    config.tipe = "direct";
    console.log("\n--- Direct Provider ---");
    console.log("Provider tersedia:");
    Object.entries(DIRECT_PROVIDERS).forEach(([k, v], i) => {
      console.log(`  ${i + 1}. ${v.nama} (${k})`);
    });

    const provInput = await tanya("Pilih provider (nomor atau nama)", "1");
    let providerKey;
    const num = parseInt(provInput, 10);
    if (!isNaN(num) && num >= 1 && num <= Object.keys(DIRECT_PROVIDERS).length) {
      providerKey = Object.keys(DIRECT_PROVIDERS)[num - 1];
    } else {
      providerKey = provInput.toLowerCase();
    }

    if (!DIRECT_PROVIDERS[providerKey]) {
      throw new Error(`Provider tidak dikenal: ${providerKey}`);
    }

    const provider = DIRECT_PROVIDERS[providerKey];
    config.provider = providerKey;

    const apiKey = await tanya(`Masukkan API Key untuk ${provider.nama}`);
    if (!apiKey) throw new Error("API Key wajib diisi");
    config.apiKey = apiKey;

    config.baseUrl = provider.baseUrl;
    config.model = await tanya(`Model default`, provider.modelDefault);

  } else {
    config.tipe = "gateway";
    console.log("\n--- Gateway / Proxy ---");
    const baseUrl = await tanya("URL Gateway (contoh: http://localhost:20128/v1)", "http://localhost:20128/v1");
    config.baseUrl = baseUrl;

    const apiKey = await tanya("API Key (kosongkan jika tidak perlu)");
    if (apiKey) config.apiKey = apiKey;

    config.model = await tanya("Model default (nama combo di gateway)", "ALL-FREE");
  }

  // Simpan konfigurasi
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");

  console.log("\n✅  Konfigurasi tersimpan di:");
  console.log(`   ${CONFIG_FILE}`);
  console.log("\nAnda sekarang bisa menjalankan: node index.js\n");

  return config;
}

/* ------------------------------------------------------------ baca config */

async function bacaConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/* ------------------------------------------------------------ ekspor */

module.exports = {
  jalankanSetup,
  bacaConfig,
  CONFIG_FILE,
  CONFIG_DIR,
  DIRECT_PROVIDERS,
};