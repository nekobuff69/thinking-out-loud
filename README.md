# Thinking Out Loud

> A browser-based art installation: ask a philosophical question, watch three local LLMs reason aloud simultaneously, hear their reasoning spoken sequentially in clean TTS audio with live waveform visualizations.

## Quick Start

### 1. LLM Provider — LM Studio (port 1234)

Load a reasoning-capable model in [LM Studio](https://lmstudio.ai/) and start the local server on port 1234. LM Studio enables CORS by default in recent versions. If requests are blocked, enable "Serve on Local Network" in Settings.

```
LM Studio → Load model → Start Server (port 1234)
```

The app health-checks `/models` on startup — unreachable models are grayed out.

### 2. TTS Server — Pocket TTS (port 8080)

```bash
cd server
pip install -r requirements.txt
```

Start the Pocket TTS server:

```bash
python server/tts-server-pocket.py

# Custom port / host
python server/tts-server-pocket.py --port 9000 --host 0.0.0.0
```

On first run the server downloads Pocket TTS (~100M params) from HuggingFace Hub. Cached in `~/.cache/huggingface/hub/` — subsequent starts are instant.

Wait for: `[HH:MM:SS] [INFO] Starting Pocket TTS server on 127.0.0.1:8080`

**Voice cloning:** Drop any `.wav` file in `voices/` and restart — the server auto-detects and loads it as a selectable voice.
### 3. Browser App — Vite (port 5173)

```bash
npm install
npm run dev       # → http://localhost:5173
```

### Demo Flow

1. Open `http://localhost:5173`
2. App shows "Loading: connecting to TTS server…" — HTTP health check
3. Once connected + LLM health-check passes, all 3 model columns appear
4. Pick a curated philosophical prompt or type your own
5. Click **Ask** — three LLMs stream reasoning concurrently via `Orchestrator`
6. Within ~2s of the first tokens, voice 1 begins speaking. When it finishes, voice 2 starts, then voice 3:
   | Model | Voice | Pan | Color |
   |---|---|---|---|
   | Qwen | `eve` | left (-0.5) | `#00ff88` |
   | Gemma | `user_clone` | center (0.0) | `#ff6644` |
   | GPT-OSS | `alba` | right (+0.5) | `#44aaff` |
8. Live waveforms animate per model column (canvas AnalyserNode viz)
9. Session auto-saves to history (localStorage, max 20 sessions) — click to replay

**Debug overlay:** Press `` ` `` or `Ctrl+Shift+D` to see per-model TTS latency (ms), audio chunk stats, token counts, and pipeline errors. Also enabled via `?debug` query parameter.

### Quick Validation

```bash
# Terminal 1 — start Pocket TTS server
python server/tts-server-pocket.py

# Terminal 2 — run integration test (once server is ready)
python server/test_server_pocket.py
```
---

## Prerequisites

- **macOS** with Apple Silicon (M1/M2/M3/M4) or CPU-only mode
- **Python 3.10+** with PyTorch (`pip install -r server/requirements.txt`)
- **Node.js 18+** for ES modules and `node:test`
- **An OpenAI-compatible LLM provider** running locally with at least one reasoning-capable model. [LM Studio](https://lmstudio.ai/) is the default (port 1234).
- **CORS:** The browser app (Vite dev on port 5173) fetches from the LLM provider on a different port, so the provider must serve CORS headers. LM Studio enables CORS by default.

## Streaming TTS Protocol

The app sends sentence-level text via HTTP POST to the Pocket TTS server:

```
POST /v1/tts  {"text": "Hello world.", "voice": "eve"}
→ streaming audio/wav (24kHz mono float32)
```

Sub-200ms first-audio latency per sentence. TextChunker splits reasoning on punctuation (`.!?;,`), max words, or silence timeout before sending.
## Architecture

```
┌──────────────────────────────────────────────────────┐
│  UI Layer (renders DOM, handles user events)         │
│  prompt-selector  column  history                    │
│  debug-overlay                                       │
├──────────────────────────────────────────────────────┤
│  Session Layer (coordinates state across models)     │
│  orchestrator → channel-pipeline (×3, per model)     │
│  event-bus (pub-sub)  storage (localStorage + test   │
│                       adapter seam via MemoryAdapter) │
├──────────────────────────────────────────────────────┤
│  LLM Layer (streaming inference)                     │
│  llm-stream → providers/openai-compatible-provider   │
│  providers/llm-provider (abstract interface)         │
│  health-check                                        │
├──────────────────────────────────────────────────────┤
│  TTS Layer (text → audio streaming)                  │
│  tts-engine (abstract streaming interface)           │
│  pocket-tts-backend (HTTP → Pocket TTS server)       │
│  text-chunker (optional prosody tuner, default: off) │
├──────────────────────────────────────────────────────┤
│  Audio Layer (Web Audio API + visualization)         │
│  audio-graph (channels + ducking)                    │
│  waveform (canvas analyser viz, idle breathing)      │
├──────────────────────────────────────────────────────┤
│  Config & Utilities                                  │
│  config.js  getReasoningContent.js  saveReasoning.js │
│  normalizeModelName.js                               │
└──────────────────────────────────────────────────────┘

External processes:
  LM Studio (port 1234)        — LLM inference
  Pocket TTS server (8080)     — TTS via HTTP
```

### State Machine

The `Orchestrator` drives a session through: `Idle → Loading → Checking → Thinking → Speaking → Done`. Errors trigger a `stop()` path that resets to `Idle` after 3s.

---

## Project Structure

| File | Responsibility |
|---|---|
| `index.html` | Root HTML + loading spinner |
| `index.js` | App bootstrap: wire UI → Orchestrator → AudioGraph |
| `config.js` | Static config: models, voices, prompts, TTS params, system prompt |
| `ui/prompt-selector.js` | Curated cards + free-text input + recent questions + Ask button |
| `ui/prompt-selector.css` | Prompt selector styles |
| `ui/column.js` | Per-model text stream, auto-scroll with scroll-back, waveform lifecycle |
| `ui/column.css` | Column styles |
| `ui/history.js` | Session history panel with replay support |
| `ui/history.css` | History panel styles |
| `ui/debug-overlay.js` | Togglable pipeline diagnostics (TTS latency, queue, tokens, errors) |
| `ui/debug-overlay.css` | Debug overlay styles |
| `styles/global.css` | Global CSS reset, variables, animations |
| `styles/top-bar.css` | Top bar layout |
| `session/orchestrator.js` | Session lifecycle coordinator (Idle → ... → Done) |
| `session/channel-pipeline.js` | Per-model pipeline: LLM tokens → TTS → audio channel |
| `session/event-bus.js` | Lightweight pub-sub event bus (`SimpleEventBus`) |
| `session/storage.js` | `SessionStore`: persistence with adapter seam |
| `session/local-storage-adapter.js` | Default storage adapter wrapping `localStorage` |
| `session/memory-storage-adapter.js` | In-memory storage adapter for tests |
| `llm/llm-stream.js` | Backward-compatible SSE streaming wrapper (`streamReasoning`) |
| `llm/health-check.js` | Provider reachability ping via `/models` |
| `llm/providers/llm-provider.js` | Abstract `LLMProvider` interface |
| `llm/providers/openai-compatible-provider.js` | OpenAI-compatible SSE implementation with `<think>` tag parsing |
| `tts/tts-engine.js` | Abstract `TTSEngine` streaming interface (`load`, `startStream`, `stop`, `destroy`) |
| `tts/pocket-tts-backend.js` | HTTP client for Pocket TTS server (sentence-level, streaming WAV) |
| `tts/text-chunker.js` | Sentence-boundary accumulator for live TTS path |
| `audio/audio-graph.js` | Web Audio routing + ducking + streaming PCM playback |
| `audio/waveform.js` | Canvas visualization from AnalyserNode (active bars + idle breathing) |
| `server/tts-server-pocket.py` | Pocket TTS HTTP server (FastAPI, streaming WAV, voice cloning) |
| `server/test_server_pocket.py` | Integration tests for the Pocket TTS server |
| `test/` | Node test runner suites |
| `docs/debug-overlay-reference.md` | Full debug overlay specification + event bus reference |
| `docs/adr/` | Architectural Decision Records (4 ADRs) |
| `getReasoningContent.js` | CLI helper: streams reasoning from an LLM endpoint |
| `saveReasoning.js` | CLI script: saves reasoning output to timestamped files |
| `normalizeModelName.js` | CLI utility: normalizes model names (strips provider prefix) |
| `package.json` | `"the-thinking-machine"`, Vite 8, TypeScript 6 |
| `tsconfig.json` | TypeScript strict check for JSDoc-typed JS (`tsc --noEmit`) |
| `vite.config.js` | Vite configuration |
| `vite-env.d.ts` | Vite client type declarations |
| `.env` | Legacy CLI script env vars (not loaded by browser) |

---

## Development

```bash
npm install

# Start Vite dev server
npm run dev

# Run tests (Node built-in test runner)
npm test                 # 91 tests, 14 suites
# Type-check JavaScript with TypeScript (strict, checkJs)
npm run typecheck

# Production build
npm run build

# Preview production build locally
npm run preview
```

### Python Server Validation

```bash
python3 -c "import py_compile; py_compile.compile('server/tts-server-pocket.py', doraise=True)"
python3 -c "import py_compile; py_compile.compile('server/test_server_pocket.py', doraise=True)"

---

## Legacy CLI Tools

The repo includes standalone CLI scripts for batch reasoning extraction:

```bash
# Configure via .env
cp .env.example .env   # (create from template)
# Set BASE_URL, CHAT_COMPLETION_ENDPOINT, MODEL

# Save reasoning output to data/<model>/<model>-reasoning-<time>-<date>.txt
node saveReasoning.js
```

These scripts are independent of the browser app and use `dotenv` for configuration.
