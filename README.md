<div align="center">

# 🚀 Omnitermux — Universal AI CLI for Termux

**A modern, zero-dependency AI chat CLI with Tool Calling, built for Termux and every terminal.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-Termux%20%7C%20Linux%20%7C%20macOS%20%7C%20Windows-blue.svg)]()
[![Dependencies](https://img.shields.io/badge/dependencies-zero-orange.svg)]()

</div>

---

Omnitermux is a universal AI assistant that runs entirely in your terminal. It connects to **any OpenAI-compatible API** — direct providers (NVIDIA, OpenRouter, Groq, Google AI, OpenAI) or local gateways (OmniRoute, 9Router, LiteLLM) — and gives the model real abilities through **AI Skills (Tool Calling)**: read and write files, and safely run shell commands, all inside a sandboxed `workspace/` folder.

Everything is written with **only Node.js built-in modules** — no `npm install`, no `node_modules`, no external dependencies.

> 💡 The interactive UI messages are displayed in **Bahasa Indonesia**, matching the original target audience.

---

## ✨ Features

- **🧭 Interactive Setup Wizard** — Guided first-run configuration with two connection modes: *Direct Provider* (API key straight to the vendor) or *Gateway / Proxy* (OmniRoute, 9Router, LiteLLM, ...).
- **🤖 AI Skills (Tool Calling)** — Standard OpenAI Function Calling schema with three tools: `read_file`, `write_file`, `run_command` — plus a hardened sandbox and per-call user confirmation.
- **📑 Model Pagination** — Model lists are paged 20 at a time with `next` / `all` navigation, active-model highlighting, and selection by number or name.
- **⌨️ Slash Commands** — `/model`, `/config`, `/tools`, `/clear`, `/help`, `/stats`, `/compact`, `/reset` — full runtime control without restarting.
- **🎨 Polished Terminal UI** — Box-drawing frames, ANSI colors (auto-disabled when piped or via `NO_COLOR`), animated spinner, live status bar with model, token count, cost, and session duration.
- **🌐 Multi-Provider Support** — NVIDIA, OpenRouter, Groq, Google AI (Gemini), OpenAI, Anthropic, plus any OpenAI-compatible gateway.
- **📊 Session Statistics** — Track messages sent/received, estimated tokens, estimated cost, and elapsed time with `/stats`.
- **🧠 Context Management** — Conversation history is automatically trimmed to stay within model context, and `/compact` lets the AI summarize the conversation on demand.
- **💾 Persistent Configuration** — Settings are stored in `~/.config/omnitermux/config.json` and survive restarts.
- **🛡️ Robust Error Handling** — Friendly Indonesian messages for `401`, `404` (model not found → suggests `/model`), `410`, `429`, and server errors.

---

## 📋 Prerequisites

| Requirement | Notes |
|-------------|-------|
| **[Termux](https://termux.dev/)** (recommended) | Or any Linux/macOS/Windows terminal |
| **Node.js ≥ 18** | Required for native `fetch` and `AbortSignal.timeout` |
| **Git** | To clone the repository |
| **API key** | From any supported provider — *or* ... |
| **OmniRoute** *(optional)* | A local gateway that provides free model combos (`ALL-FREE`) |

Install Node.js and Git in Termux:

```bash
pkg update && pkg upgrade
pkg install nodejs git
```

---

## 🚀 Installation

```bash
# 1. Clone the repository
git clone https://github.com/YusuP28/omnitermux.git
cd omnitermux

# 2. Run it (no npm install needed — zero dependencies!)
node index.js
```

Or equivalently:

```bash
npm start
```

On first run, the setup wizard starts automatically.

---

## ⚙️ First-Time Setup

When no configuration exists, Omnitermux launches an interactive wizard:

```
Pilih tipe koneksi:
  1. Direct Provider (API Key langsung ke NVIDIA, OpenRouter, Groq, dll)
  2. Gateway / Proxy (OmniRoute, 9Router, LiteLLM, dll)
```

### Option 1 — Direct Provider

1. **Choose a provider** (number or name):

   | # | Provider | Auto model list |
   |---|----------|:---------------:|
   | 1 | NVIDIA | 📋 |
   | 2 | OpenRouter | 📋 |
   | 3 | Groq | 📋 |
   | 4 | Google AI (Gemini) | 📋 |
   | 5 | Anthropic | 📝 *(manual entry)* |
   | 6 | OpenAI | 📋 |

2. **Enter your API key** (e.g. `nvapi-...` for NVIDIA).
3. **Pick a model** — the wizard fetches the live model list from the vendor API and shows it in pages:

   ```
   Model 1-20 dari 85 (halaman 1):
     1. 01-ai/yi-large
     2. adept/fuyu-8b
     ...
   Ketik 'next' untuk 20 berikutnya, atau 'all' untuk semua model.

   Pilih model (nomor 1-85, 'next', 'all', atau nama model, atau Enter untuk [meta/llama-3.1-70b-instruct]):
   ```

   - Type a **number** (1–85) or a **model name** to select it.
   - `next` → next page · `all` → show every model · `Enter` → safe fallback model.

### Option 2 — Gateway / Proxy

1. **Gateway URL** — default: `http://localhost:20128/v1` (OmniRoute).
2. **API key** — leave empty if your gateway doesn't require one.
3. **Model name** — the combo name exposed by your gateway (default: `ALL-FREE`).

Your choices are saved to `~/.config/omnitermux/config.json`:

```json
{
  "versi": 1,
  "tipe": "direct",
  "provider": "nvidia",
  "apiKey": "nvapi-...",
  "baseUrl": "https://integrate.api.nvidia.com/v1",
  "model": "deepseek-ai/deepseek-v4.1-flash"
}
```

To re-run the wizard later, either type `/config` → `edit`, or delete the file:

```bash
rm ~/.config/omnitermux/config.json
```

---

## 📜 Commands

Type these at the `USER >` prompt:

| Command | Description |
|---------|-------------|
| `/help` | Show the help table with all available commands |
| `/model` | Interactively browse & switch models (paginated, Direct Providers) |
| `/config` | View current configuration; type `edit` to re-run the setup wizard |
| `/tools` | List available AI Skills (tools) with usage examples |
| `/clear` | Clear the terminal screen |
| `/stats` | Show session statistics (tokens, cost, duration, messages) |
| `/compact` | Ask the AI to summarize the conversation to save context |
| `/reset` | Wipe conversation history and reset session counters |
| `exit` | Quit (also `quit` / `/exit` / `Ctrl+C`) |

---

## 🤖 AI Skills (Tool Calling)

Omnitermux exposes three tools to the model using the **standard OpenAI Function Calling JSON Schema**, so any compatible model can use them.

| Tool | Description | Example call |
|------|-------------|--------------|
| `read_file` | Read a file inside the workspace | `read_file({ "path": "catatan.txt" })` |
| `write_file` | Create or overwrite a file in the workspace | `write_file({ "path": "todo.txt", "content": "Beli kopi" })` |
| `run_command` | Run a shell command (max 10 seconds) | `run_command({ "command": "ls -la" })` |

### Security model

Safety is layered — the model never gets unchecked access to your device:

| Layer | Mechanism |
|-------|-----------|
| **📁 Sandbox** | All file paths resolve inside `workspace/`. Path traversal (`../`, absolute paths) is rejected with `Akses ditolak`. |
| **🚫 Command blocklist** | Dangerous patterns are blocked: `rm -rf`, `mkfs`, `dd if=`, `reboot`, `shutdown`, `su`, `sudo`, `passwd`, `chmod 777`, `> /dev/`, fork bombs, and more. |
| **⏱️ Timeout** | Every command is killed after **10 seconds**; command length is capped at 500 characters. |
| **✅ User confirmation** | `write_file` and `run_command` pause and ask `Izinkan <tool>? (y/N)` before executing. `read_file` runs automatically. |
| **🧪 Auto-approve (testing)** | Set `OMNITERMUX_AUTO_APPROVE=1` (or `OMNIROUTE_AUTO_APPROVE=1`) to skip confirmations. |

Tool calls and their results are streamed into the conversation automatically — the model sees the output and continues its reasoning loop.

---

## 💡 Examples

Start the app:

```bash
node index.js
```

**Create a file:**

```
USER > Buat file bernama todo.txt berisi daftar belanja: beras, telur, kopi

  🔧 write_file  file: todo.txt (34 char)
  ⚠️  Izinkan write_file? (y/N) y
  ✅ Berhasil: 34 bytes written
```

**Read it back:**

```
USER > Apa isi todo.txt?

  🔧 read_file  file: todo.txt
  ✅ Berhasil: beras
  telur
  kopi
```

**Run a command:**

```
USER > Jalankan node --version di workspace

  🔧 run_command  cmd: node --version
  ⚠️  Izinkan run_command? (y/N) y
  ✅ Berhasil: v18.20.4
```

**Switch models on the fly:**

```
USER > /model

🔄 Mengambil daftar model dari NVIDIA...
📋 Model 1–20 dari 85 (halaman 1):
   1. 01-ai/yi-large
   ...
  Ketik 'next' untuk 20 berikutnya, atau 'all' untuk semua model.

Pilih model (nomor 1-85, 'next', 'all', atau nama model): 8
✅ Model berhasil diubah menjadi: deepseek-ai/deepseek-v4.1-flash
```

---

## 🗂️ Project Structure

```
omnitermux/
├── index.js          # Main entry: chat loop, slash commands, tool execution loop
├── setup.js          # Interactive setup wizard & config persistence
├── tools.js          # AI Skills: JSON Schema, sandbox, safety checks, dispatcher
├── workspace/        # Sandboxed folder for all file & command operations
├── package.json      # Metadata (zero runtime dependencies)
└── ~/.config/omnitermux/config.json   # Your saved configuration
```

---

## 📄 License

Released under the [MIT License](LICENSE).

```
MIT License

Copyright (c) 2026 Omnitermux

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

<div align="center">

**Made with ❤️ for the Termux community**

⭐ Star this repo if you find it useful!

</div>
