"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { stdin, stdout } = require("node:process");

const CONFIG_DIR = path.join(process.env.HOME || "/data/data/com.termux/files/home", ".config", "omnitermux");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DIRECT_PROVIDERS = {
  nvidia: { nama: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1", modelDefault: "nvidia/nemotron-3-ultra-550b-a55b", modelsEndpoint: "models", authType: "bearer" },
  openrouter: { nama: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", modelDefault: "openrouter/auto", modelsEndpoint: "models", authType: "bearer" },
  groq: { nama: "Groq", baseUrl: "https://api.groq.com/openai/v1", modelDefault: "llama-3.1-70b-versatile", modelsEndpoint: "models", authType: "bearer" },
  google: { nama: "Google AI (Gemini)", baseUrl: "https://generativelanguage.googleapis.com/v1beta", modelDefault: "gemini-1.5-flash", modelsEndpoint: "models", authType: "query_key" },
  anthropic: { nama: "Anthropic", baseUrl: "https://api.anthropic.com/v1", modelDefault: "claude-3-5-sonnet-20241022", modelsEndpoint: null, authType: "bearer" },
  openai: { nama: "OpenAI", baseUrl: "https://api.openai.com/v1", modelDefault: "gpt-4o-mini", modelsEndpoint: "models", authType: "bearer" },
};

const SAFE_FALLBACK_MODEL = "meta/llama-3.1-70b-instruct";

async function ambilDaftarModel(providerKey, apiKey) {
  const provider = DIRECT_PROVIDERS[providerKey];
  if (!provider.modelsEndpoint) throw new Error(`Provider ${provider.nama} tidak mendukung daftar model otomatis`);
  const url = `${provider.baseUrl}/${provider.modelsEndpoint}`;
  let headers = { "Accept": "application/json" };
  if (provider.authType === "bearer") headers["Authorization"] = `Bearer ${apiKey}`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const urlWithKey = provider.authType === "query_key" ? `${provider.baseUrl}/${provider.modelsEndpoint}?key=${encodeURIComponent(apiKey)}` : `${provider.baseUrl}/${provider.modelsEndpoint}`;
    const response = await fetch(urlWithKey, { headers, signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) { const errText = await response.text(); throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`); }
    const data = await response.json();
    let models = [];
    if (providerKey === "google") models = data.models?.map(m => m.name.replace("models/", "")) || [];
    else if (providerKey === "openrouter") models = data.data?.map(m => m.id) || [];
    else models = data.data?.map(m => m.id) || [];
    const chatModels = models.filter(m => !m.includes("embedding") && !m.includes("moderation") && !m.includes("whisper") && !m.includes("tts") && !m.includes("dall-e"));
    return chatModels.length > 0 ? chatModels : models;
  } catch (err) { throw new Error(`Gagal mengambil daftar model: ${err.message}`); }
}

async function pilihModel(providerKey, apiKey, defaultModel) {
  console.log(`\nMengambil daftar model dari ${DIRECT_PROVIDERS[providerKey].nama}...`);
  try {
    const models = await ambilDaftarModel(providerKey, apiKey);
    
    if (models.length === 0) {
      console.log("  Tidak ada model yang ditemukan, gunakan default.");
      return defaultModel;
    }

    const tampilkan = models.slice(0, 20);
    console.log("\nModel tersedia:");
    tampilkan.forEach((m, i) => {
      const mark = m === defaultModel ? " (default)" : "";
      console.log(`  ${i + 1}. ${m}${mark}`);
    });
    if (models.length > 20) console.log(`  ... dan ${models.length - 20} model lainnya`);

    while (true) {
      const input = await tanya(`\nPilih model (nomor 1-${tampilkan.length}, atau ketik nama model, atau Enter untuk [${SAFE_FALLBACK_MODEL}])`, "");
      
      // Jika user menekan Enter tanpa input
      if (input === "") {
        console.log(`  Menggunakan model aman: ${SAFE_FALLBACK_MODEL}`);
        return SAFE_FALLBACK_MODEL;
      }
      
      const num = parseInt(input, 10);
      if (!isNaN(num) && num >= 1 && num <= tampilkan.length) return tampilkan[num - 1];
      
      if (input && models.includes(input)) return input;
      
      if (input) { const confirm = await tanyaYesNo(`Model "${input}" tidak dalam daftar. Tetap gunakan?`, false); if (confirm) return input; }
      
      console.log("  Input tidak valid. Coba lagi.");
    }
  } catch (err) { console.log(`  ⚠️  ${err.message}`); console.log("  Fallback ke input manual."); return await tanya(`Model default`, defaultModel); }
}

function tanya(pertanyaan, defaultVal = "") {
  return new Promise((resolve) => { const prompt = defaultVal ? `${pertanyaan} [${defaultVal}]: ` : `${pertanyaan}: `; stdout.write(prompt); stdin.once("data", (data) => { const input = data.toString().trim(); resolve(input || defaultVal); }); });
}

function tanyaYesNo(pertanyaan, defaultYes = true) {
  return new Promise((resolve) => { const hint = defaultYes ? "Y/n" : "y/N"; stdout.write(`${pertanyaan} [${hint}]: `); stdin.once("data", (data) => { const input = data.toString().trim().toLowerCase(); if (!input) resolve(defaultYes); else resolve(input === "y" || input === "yes"); }); });
}

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
    Object.entries(DIRECT_PROVIDERS).forEach(([k, v], i) => { const hasModels = v.modelsEndpoint ? "📋" : "📝"; console.log(`  ${i + 1}. ${v.nama} (${k}) ${hasModels}`); });
    const provInput = await tanya("Pilihan provider (nomor atau nama)", "1");
    let providerKey; const num = parseInt(provInput, 10);
    if (!isNaN(num) && num >= 1 && num <= Object.keys(DIRECT_PROVIDERS).length) providerKey = Object.keys(DIRECT_PROVIDERS)[num - 1];
    else providerKey = provInput.toLowerCase();
    if (!DIRECT_PROVIDERS[providerKey]) throw new Error(`Provider tidak dikenal: ${providerKey}`);
    const provider = DIRECT_PROVIDERS[providerKey];
    config.provider = providerKey;
    const apiKey = await tanya(`Masukkan API Key untuk ${provider.nama}`);
    if (!apiKey) throw new Error("API Key wajib diisi");
    config.apiKey = apiKey;
    config.baseUrl = provider.baseUrl;
    if (provider.modelsEndpoint) config.model = await pilihModel(providerKey, apiKey, provider.modelDefault);
    else config.model = await tanya(`Model default`, provider.modelDefault);
  } else {
    config.tipe = "gateway";
    console.log("\n--- Gateway / Proxy ---");
    const baseUrl = await tanya("URL Gateway (contoh: http://localhost:20128/v1)", "http://localhost:20128/v1");
    config.baseUrl = baseUrl;
    const apiKey = await tanya("API Key (kosongkan jika tidak perlu)");
    if (apiKey) config.apiKey = apiKey;
    config.model = await tanya("Model default (nama combo di gateway)", "ALL-FREE");
  }
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  console.log("\n✅  Konfigurasi tersimpan di:");
  console.log(`   ${CONFIG_FILE}`);
  console.log("\nAnda sekarang bisa menjalankan: node index.js\n");
  return config;
}

function tanya(pertanyaan, defaultVal = "") {
  return new Promise((resolve) => { const prompt = defaultVal ? `${pertanyaan} [${defaultVal}]: ` : `${pertanyaan}: `; stdout.write(prompt); stdin.once("data", (data) => { const input = data.toString().trim(); resolve(input || defaultVal); }); });
}

function tanyaYesNo(pertanyaan, defaultYes = true) { return new Promise((resolve) => { const hint = defaultYes ? "Y/n" : "y/N"; stdout.write(`${pertanyaan} [${hint}]: `); stdin.once("data", (data) => { const input = data.toString().trim().toLowerCase(); if (!input) resolve(defaultYes); else resolve(input === "y" || input === "yes"); }); }); }

module.exports = { jalankanSetup, bacaConfig, CONFIG_FILE, CONFIG_DIR, DIRECT_PROVIDERS };

async function bacaConfig() {
  try { const data = await fs.readFile(CONFIG_FILE, "utf-8"); return JSON.parse(data); }
  catch (err) { if (err.code === "ENOENT") return null; throw err; }
}