"use strict";

/**
 * tools.js — Fondasi Tool Calling untuk omnitermux.
 * Standar: OpenAI Function Calling (JSON Schema).
 * Hanya modul bawaan Node.js.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

/* ------------------------------------------------------------ konfigurasi */

const WORKSPACE_ROOT = path.resolve(__dirname, "workspace");
const TIMEOUT_MS = 10_000;

// Daftar perintah yang diblokir (substring matching, case-insensitive)
const PERINTAH_TERLARANG = [
  "rm -rf",
  "rm -rf /",
  "mkfs",
  "dd if=",
  "reboot",
  "shutdown",
  "poweroff",
  "halt",
  "su ",
  "sudo ",
  "passwd",
  "chmod 777",
  "chown root",
  "> /dev/",
  ":(){ :|:& };:", // fork bomb
];

/* ------------------------------------------------------------ JSON Schema */

const daftarTools = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Membaca isi file di dalam folder workspace",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relatif terhadap folder workspace (contoh: 'catatan.txt' atau 'src/index.js')",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Menulis konten ke file di dalam folder workspace",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path relatif terhadap folder workspace (contoh: 'output.txt' atau 'src/app.js')",
          },
          content: {
            type: "string",
            description: "Isi teks yang akan ditulis ke file",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Menjalankan perintah terminal (hanya perintah aman, maksimal 10 detik)",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Perintah shell yang akan dijalankan (contoh: 'ls -la', 'node --version', 'npm test')",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

/* ------------------------------------------------------------ utilitas keamanan */

function validasiPathWorkspace(relatif) {
  const absolut = path.resolve(WORKSPACE_ROOT, relatif);
  const workspaceAbs = path.resolve(WORKSPACE_ROOT);

  // Pastikan path berada di dalam workspace (hindari traversal ../)
  if (!absolut.startsWith(workspaceAbs + path.sep) && absolut !== workspaceAbs) {
    throw new Error(`Akses ditolak: path keluar dari workspace: ${relatif}`);
  }
  return absolut;
}

function cekPerintahAman(command) {
  const lower = command.toLowerCase();
  for (const terlarang of PERINTAH_TERLARANG) {
    if (lower.includes(terlarang.toLowerCase())) {
      throw new Error(`Perintah diblokir (berbahaya): "${terlarang}"`);
    }
  }
  // Batasi panjang perintah
  if (command.length > 500) {
    throw new Error("Perintah terlalu panjang (maks 500 karakter)");
  }
}

/* ------------------------------------------------------------ implementasi tool */

async function _read_file({ path: relatif }) {
  const absolut = validasiPathWorkspace(relatif);
  try {
    const isi = await fs.readFile(absolut, "utf-8");
    return { ok: true, content: isi };
  } catch (err) {
    if (err.code === "ENOENT") throw new Error(`File tidak ditemukan: ${relatif}`);
    throw new Error(`Gagal membaca file: ${err.message}`);
  }
}

async function _write_file({ path: relatif, content }) {
  const absolut = validasiPathWorkspace(relatif);
  // Buat direktori parent jika belum ada
  await fs.mkdir(path.dirname(absolut), { recursive: true });
  await fs.writeFile(absolut, content, "utf-8");
  return { ok: true, written: content.length };
}

function _run_command({ command }) {
  return new Promise((resolve, reject) => {
    try {
      cekPerintahAman(command);
    } catch (err) {
      return reject(err);
    }

    // Jalankan via shell (sh -c) agar mendukung pipe, redirect, dll
    const child = spawn("sh", ["-c", command], {
      timeout: TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });

    child.on("error", (err) => reject(new Error(`Gagal menjalankan perintah: ${err.message}`)));

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
      } else {
        resolve({ ok: false, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code });
      }
    });
  });
}

/* ------------------------------------------------------------ dispatcher */

async function eksekusiTool(namaTool, argumen) {
  switch (namaTool) {
    case "read_file":
      return await _read_file(argumen);
    case "write_file":
      return await _write_file(argumen);
    case "run_command":
      return await _run_command(argumen);
    default:
      throw new Error(`Tool tidak dikenal: ${namaTool}`);
  }
}

/* ------------------------------------------------------------ inisialisasi */

async function siapkanWorkspace() {
  try {
    await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
    // Buat file .gitkeep agar folder tidak kosong
    await fs.writeFile(path.join(WORKSPACE_ROOT, ".gitkeep"), "", "utf-8");
  } catch {
    // abaikan error jika sudah ada
  }
}

// Inisialisasi workspace saat modul dimuat
siapkanWorkspace();

/* ------------------------------------------------------------ ekspor */

module.exports = {
  daftarTools,
  eksekusiTool,
  // ekspor fungsi internal untuk testing
  _read_file,
  _write_file,
  _run_command,
  validasiPathWorkspace,
  cekPerintahAman,
  WORKSPACE_ROOT,
};