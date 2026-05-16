# LIPSIDE — Web IDE for LIPS Pipelines

LIPSIDE is a browser-based IDE for building and running [LIPS](https://github.com/qia-uofa/lips) pipelines. It provides a VS Code-inspired interface for managing workspaces, editing build files, configuring LLM providers, streaming build output in real time, and launching an integrated terminal — all without leaving the browser.

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Interface Overview](#interface-overview)
- [Pipeline Management](#pipeline-management)
- [File Editor](#file-editor)
- [Configuration](#configuration)
- [Build System](#build-system)
- [Terminal](#terminal)
- [API Reference](#api-reference)
- [Supported LLM Providers](#supported-llm-providers)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Architecture](#architecture)
- [Dependencies](#dependencies)

---

## Features

- **Visual pipeline management** — create, rename, delete, and navigate multi-stage LIPS pipelines
- **Full file editor** — syntax-highlighted editing for Python, Markdown, Shell, JSON, and more via CodeMirror
- **Multi-tab editing** — VS Code-style tabs with dirty-state tracking and drag-to-reorder
- **Real-time build streaming** — WebSocket-based live output from `lips build`
- **40+ LLM providers** — Anthropic, OpenAI, Google, Mistral, Ollama, and many more, all configurable in-app
- **Pipeline config editor** — change model, temperature, max tokens, API keys, and conversation templates without touching files
- **Embedded terminal** — launch a native terminal or use the in-browser PTY emulator
- **Graph view** — Mermaid-based visual diagram of stage dependencies
- **Safe file operations** — recycle bin integration for deletes, path traversal protection
- **Dark theme** — VS Code-inspired UI with fully custom CSS variables

---

## Installation

**Requirements:** Python 3.10+, [LIPS](https://github.com/qia-uofa/lips) installed

```bash
git clone https://github.com/qia-uofa/lipside
cd lipside
pip install -e .
```

---

## Usage

```bash
lipside [--workspace PATH] [--host HOST] [--port PORT] [--all-interfaces]
```

| Flag | Default | Description |
|---|---|---|
| `--workspace PATH` | Current directory | Path to your LIPS workspace |
| `--host HOST` | `127.0.0.1` | Bind address |
| `--port PORT` | `8765` | Listen port |
| `--all-interfaces` | — | Bind to `0.0.0.0` (network accessible) |

LIPSIDE opens your default browser automatically after startup.

**Examples:**

```bash
# Start in the current directory
lipside

# Point at a specific workspace
lipside --workspace ~/my-workspace

# Run on a custom port
lipside --workspace . --port 9000

# Expose on the local network
lipside --all-interfaces --port 8765
```

---

## Interface Overview

LIPSIDE uses a five-row grid layout:

```
┌─────────────────────────────────────────────────┐
│  Menu bar  (File · Edit · View · Pipeline · …)  │
├─────────────────────────────────────────────────┤
│  Title bar  (workspace · pipeline · buttons)    │
├──────────┬──────────────────────┬───────────────┤
│          │                      │               │
│ Sidebar  │    Code editor       │   Preview     │
│          │                      │               │
├──────────┴──────────────────────┴───────────────┤
│  Build status bar                               │
├─────────────────────────────────────────────────┤
│  Build output panel  (collapsible)              │
└─────────────────────────────────────────────────┘
```

### Sidebar views

| View | Contents |
|---|---|
| **repo** | Generated/source files in the stage repository |
| **build** | Build files (`.md`, `.py`, `.sh`) that drive the LLM |
| **out** | Timestamped log outputs from previous runs |
| **graph** | Mermaid diagram of the pipeline stage graph |

Click any file in the sidebar to open it in the editor. Right-click for context menu actions (rename, delete, create).

---

## Pipeline Management

### Create a pipeline

**Pipeline → New Pipeline** opens the creation dialog:

1. Enter a pipeline name
2. Pick an LLM provider (40+ available)
3. Select a model from the provider's list
4. Set generation parameters (max tokens, temperature, timeout)
5. Add stages — each with a name and a default build file name
6. Confirm — LIPSIDE scaffolds all directories, `config.json`, and build file stubs

### Add stages to an existing pipeline

**Pipeline → Add Stages** appends new stages to an existing pipeline without overwriting existing config.

### Rename and delete

Right-click a stage in the sidebar, or use the **Stage** menu. When you rename a stage, all `TARGET=` references in sibling build files are updated automatically.

### Purge outputs

| Operation | What it removes |
|---|---|
| **Purge stage** | Clears `repo/` (except `.gitignore`), removes `out/` |
| **Purge pipeline** | Applies purge to every stage in the pipeline |
| **Purge out only** | Removes only the `out/` log directory, leaves `repo/` intact |

---

## File Editor

### Editor features

- **Syntax highlighting** — Python, Markdown, Shell, JSON, and more (CodeMirror 5)
- **Dracula dark theme** — consistent with the overall UI
- **Multi-tab management** — open multiple files simultaneously; tabs show unsaved state
- **Markdown preview** — toggle a rendered preview pane for `.md` files
- **PDF and image display** — PDFs show extracted text; images are displayed inline (read-only)
- **Find & Replace** — Ctrl+F / Ctrl+H with regex support
- **Format JSON** — auto-format JSON files from the Edit menu

### Tab operations

| Action | How |
|---|---|
| Open file | Click in sidebar |
| Close tab | Click × on tab, or Ctrl+W |
| Close all tabs | File → Close All |
| Save file | Ctrl+S |
| Save all | Ctrl+Shift+S |
| Reorder tabs | Drag and drop |

---

## Configuration

### Pipeline config editor

**Pipeline → Edit Config** opens a dialog with:

- **Model** — provider and model string (e.g. `anthropic/claude-opus-4-6`)
- **Max tokens** — maximum response length
- **Temperature** — sampling temperature (0 = deterministic)
- **Timeout** — API call timeout in seconds
- **API key variable** — which `.env` variable holds the API key

### Conversation template editor

**Pipeline → Edit Messages** opens the messages array editor:

- Add, remove, and reorder system / user / assistant messages
- Drag to reorder messages
- Changes are saved directly to `config.json`

These messages serve as few-shot examples that teach the LLM the expected `<file>` output format.

### `.env` files

LIPSIDE manages environment variables at three levels:

| Level | File location | Edited via |
|---|---|---|
| Workspace | `{workspace}/.env` | View → Workspace .env |
| Pipeline | `{workspace}/{pipeline}/.env` | Pipeline → Edit .env |
| Stage | Inline `env` blocks in build `.md` files | File editor |

### `config.json` structure

```json
{
  "generate": {
    "model": "anthropic/claude-opus-4-6",
    "max_tokens": 20000,
    "temperature": 0.0,
    "timeout": 1200
  },
  "api_var": "ANTHROPIC_API_KEY",
  "messages": [
    { "role": "system",    "content": "You are a code transformation assistant." },
    { "role": "user",      "content": "Refactor this file:\n<file path=\"./a.py\">...</file>" },
    { "role": "assistant", "content": "<file path=\"./a.py\">...</file>" }
  ]
}
```

---

## Build System

### Running a build

**Stage → Run Build** (or the ▶ button) sends `lips build <script> <stage_path>` to the backend and streams output via WebSocket.

The build output panel at the bottom shows live output. You can:
- Copy the full output
- Clear the panel
- Collapse/expand the panel

### Build queue

Select multiple stages and queue them — LIPSIDE runs them sequentially and displays pass/fail status for each.

### Build output logging

Every run writes to:

```
stage/out/<provider>/<api_key_prefix>/<model>/<timestamp>/
├── messages.json   # Full prompt sent to the LLM
├── response.md     # Raw LLM response
└── files.json      # Extracted file paths and contents
```

Browse these in the **out** sidebar view.

---

## Terminal

LIPSIDE can launch or embed a terminal for direct command-line access.

### Native terminal launch

**Stage → Open Terminal** (or right-click a directory) opens a system terminal at the selected path:

| OS | Terminal launched |
|---|---|
| Windows | Windows Terminal (preferred), falls back to cmd.exe |
| macOS | Terminal.app |
| Linux | GNOME Terminal, Konsole, xterm, XFCE Terminal (auto-detected) |

### Embedded PTY terminal

A WebSocket-backed terminal is available in-browser:

- **Unix/Linux/macOS** — uses native PTY (`pty` module)
- **Windows** — uses PyWinPTY for native console emulation
- Inherits the current Python virtual environment and `PATH`
- Supports terminal resizing

---

## API Reference

LIPSIDE exposes a REST + WebSocket API. All endpoints are served at `http://localhost:{port}`.

### Workspace

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/workspace` | List pipelines in the current workspace |
| `POST` | `/api/workspace/path` | Change the active workspace directory |
| `GET` | `/api/workspace/pick` | Open native folder picker dialog |
| `POST` | `/api/workspace/set-pipeline` | Set the active pipeline |
| `GET` | `/api/env/workspace` | Read workspace `.env` |
| `PUT` | `/api/env/workspace` | Write workspace `.env` |
| `GET` | `/api/env/workspace/keys` | List variable names in workspace `.env` |

### Stage & Pipeline Operations

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/rename-stage/{pipeline}/{stage}` | Rename a stage (updates TARGET references) |
| `DELETE` | `/api/stage/{pipeline}/{stage}` | Delete a stage (moves to recycle bin) |
| `DELETE` | `/api/pipeline/{pipeline}` | Delete a pipeline (moves to recycle bin) |

### File Operations

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/files/{pipeline}/{stage}/{view}` | List files in a view (`repo`, `build`, `out`) |
| `GET` | `/api/file/{pipeline}/{stage}/{view}?path=` | Read a file |
| `PUT` | `/api/file/{pipeline}/{stage}/{view}?path=` | Write a file |
| `POST` | `/api/file/{pipeline}/{stage}/{view}` | Create a file or directory |
| `DELETE` | `/api/file/{pipeline}/{stage}/{view}?path=` | Delete a file (moves to recycle bin) |
| `POST` | `/api/rename/{pipeline}/{stage}/{view}` | Rename or move a file |
| `GET` | `/api/resolve-path` | Resolve a virtual path to an absolute path |
| `POST` | `/api/open-terminal` | Launch a native terminal at a directory |

### Pipeline Configuration

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/create/providers` | List available LLM providers and their models |
| `POST` | `/api/create/pipeline` | Create a new pipeline with stages |
| `GET` | `/api/config/{pipeline}` | Get pipeline config fields |
| `PUT` | `/api/config/{pipeline}` | Update pipeline config fields |
| `GET` | `/api/config/{pipeline}/messages` | Get conversation template |
| `PUT` | `/api/config/{pipeline}/messages` | Update conversation template |
| `GET` | `/api/env/{pipeline}` | Read pipeline `.env` |
| `PUT` | `/api/env/{pipeline}` | Write pipeline `.env` |

### Purge

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/purge-out/{pipeline}/{stage}` | Remove only `out/` directory |
| `POST` | `/api/purge/{pipeline}/{stage}` | Purge stage (`repo/` + `out/`) |
| `POST` | `/api/purge/{pipeline}` | Purge all stages in a pipeline |

### WebSockets

| Path | Description |
|---|---|
| `WS /ws/build?pipeline=…&stage=…&script=…` | Stream live build output |
| `WS /ws/terminal?cwd=…` | PTY terminal session |

---

## Supported LLM Providers

LIPSIDE includes built-in provider and model definitions for 40+ providers, browsable directly in the New Pipeline dialog.

**Hosted models:**
Anthropic · OpenAI · Google Gemini · xAI (Grok) · Mistral · Cohere · DeepSeek · Perplexity · AI21 · Nvidia NIM

**Cloud infrastructure:**
Azure OpenAI · AWS Bedrock · AWS SageMaker · Oracle OCI · IBM WatsonX · Databricks · Cloudflare Workers AI

**GPU inference clouds:**
Groq · Cerebras · SambaNova · Fireworks AI · Together AI · DeepInfra · Hyperbolic · Lambda · Replicate · HuggingFace

**Routing:**
OpenRouter

**Local / self-hosted:**
Ollama · vLLM · LM Studio

All providers are configured using LiteLLM's `"provider/model"` string format in `config.json`.

---

## Keyboard Shortcuts

### Editor

| Shortcut | Action |
|---|---|
| `Ctrl+S` | Save current file |
| `Ctrl+Shift+S` | Save all open files |
| `Ctrl+W` | Close current tab |
| `Ctrl+F` | Find |
| `Ctrl+H` | Find and replace |
| `Ctrl+G` | Go to line |
| `Ctrl+A` | Select all |

### View & Navigation

| Shortcut | Action |
|---|---|
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+Shift+P` | Toggle Markdown preview |
| `Ctrl++` / `Ctrl+-` | Zoom in / out |

### Pipeline & Stage

| Shortcut | Action |
|---|---|
| `F5` / `Ctrl+R` | Run build for current stage |
| `Ctrl+Shift+R` | Run all stages |

A full shortcuts reference is available from **Help → Keyboard Shortcuts**.

---

## Architecture

### Backend

LIPSIDE is a [FastAPI](https://fastapi.tiangolo.com/) application split into seven router modules:

| Module | Responsibility |
|---|---|
| `workspace.py` | Workspace switching, pipeline discovery, workspace `.env` |
| `files.py` | File CRUD, directory listing, terminal launching |
| `build.py` | WebSocket streaming for `lips build` execution |
| `create.py` | Pipeline scaffolding, provider/model catalog |
| `config.py` | `config.json` and pipeline `.env` read/write |
| `purge.py` | Clean generated files |
| `terminal.py` | WebSocket PTY emulation (cross-platform) |

### Frontend

A single-page application using **vanilla JavaScript** — no build step, no framework:

| Library | Version | Purpose |
|---|---|---|
| CodeMirror | 5.65.16 | Syntax-highlighting code editor |
| Marked | 9.1.6 | Markdown rendering |
| Mermaid | 10 | Pipeline graph diagrams |

All frontend assets are in `static/`: `index.html`, `app.js`, `style.css`.

### Security

- **Path traversal protection** — all file operations validate that resolved paths stay within the workspace
- **Symlink safety** — symlinks are resolved before path checks
- **Recycle bin deletes** — files are moved to the system recycle bin, never permanently deleted on first pass
- **Local-only by default** — server binds to `127.0.0.1` unless `--all-interfaces` is set

---

## Dependencies

| Package | Purpose |
|---|---|
| `fastapi` | REST API framework |
| `uvicorn` | ASGI server |
| `websockets` | WebSocket support |
| `pywinpty` | Windows PTY emulation (Windows only) |
| `python-dotenv` | `.env` file parsing |
| `send2trash` | Safe recycle bin deletion |
| `litellm` | Multi-provider LLM API abstraction |
| `pdfplumber` | PDF text extraction |
| `python-docx` | Word document handling |
| `python-pptx` | PowerPoint handling |
| `openpyxl` | Excel handling |
| `pathspec` | gitignore-style path matching |

---

## Related

**[LIPS](https://github.com/qia-uofa/lips)** — The underlying pipeline engine that LIPSIDE wraps. Use LIPS directly from the command line, or use LIPSIDE for a visual interface.
