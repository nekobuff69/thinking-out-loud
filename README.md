# Thinking Out Loud

> A browser-based art installation: ask a philosophical question, watch three local LLMs reason aloud in real time, with synchronized TTS audio and live waveform visualizations.

## Live Demo

Three processes run simultaneously:

### 1. LLM Provider — LM Studio (port 1234)

Load a reasoning-capable model in [LM Studio](https://lmstudio.ai/) and start the local server on port 1234. LM Studio enables CORS by default in recent versions. If requests are blocked, enable "Serve on Local Network" in Settings.

```
LM Studio → Load model → Start Server (port 1234)
```

The app health-checks `/models` on startup — unreachable models are grayed out.

### 2. TTS Server — Python+MLX (port 8765)

```bash
cd server
pip install -r requirements.txt
```

> **Note:** `moshi-mlx` depends on `sentencepiece==0.2`, which may need a Rust toolchain for source builds on macOS. If the pip build fails:
> ```bash
> curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # install Rust
> pip install -r requirements.txt                                     # retry
> ```

Start the server:

```bash
# Full precision (best quality, needs Apple Silicon)
python server/tts-server.py

# 8-bit quantized for slower Macs (M1 Air, etc.)
python server/tts-server.py --quantize 8

# Custom port
python server/tts-server.py --port 9000
```

On first run the server downloads the Kyutai TTS model (~0.75B params, several GB), Mimi codec, and voice embeddings from HuggingFace Hub. These are cached in `~/.cache/huggingface/hub/` — subsequent starts are instant.

Wait for: `[HH:MM:SS] TTS server ready on ws://localhost:8765`

### 3. Browser App — Vite (port 5173)

```bash
npm install
npm run dev       # → http://localhost:5173
```

### Demo Flow

1. Open `http://localhost:5173`
2. App shows "Loading: connecting to TTS server…" — WebSocket handshake
3. Once connected + LLM health-check passes, all 3 model columns appear
4. Pick a curated philosophical prompt or type your own
5. Toggle **Chorus** (all voices simultaneously, spatial stereo) or **Monologue** (sequential)
6. Click **Ask** — three LLMs stream reasoning concurrently
7. Within ~2s of the first tokens, all 3 voices begin speaking:
   | Model | Voice | Pan | Color |
   |---|---|---|---|
   | Qwen | `alba-mackenna/casual.wav` | left (-0.7) | `#00ff88` |
   | Gemma | `alba-mackenna/merchant.wav` | center (0.0) | `#ff6644` |
   | GPT-OSS | `alba-mackenna/announcer.wav` | right (+0.7) | `#44aaff` |
8. Live waveforms animate per model column
9. Session auto-saves to history — click to replay

**Debug overlay:** Press `` ` `` or `Ctrl+Shift+D` to see per-model TTS latency (ms), audio chunk stats, token counts, and pipeline errors.

### Quick Validation

Before running the full demo, verify the TTS server works standalone:

```bash
# Terminal 1 — start server
python server/tts-server.py

# Terminal 2 — run integration test (once server is ready)
python server/test_server.py
```

Expected: `Results: 4/4 tests passed`

---

## Prerequisites

- **macOS** with Apple Silicon (M1/M2/M3/M4). MLX requires Metal GPU / Neural Engine.
- **Python 3.12+** with MLX and `moshi-mlx` (`pip install -r server/requirements.txt`)
- **Node.js 18+** for ES modules and `node:test`
- **An OpenAI-compatible LLM provider** running locally with at least one reasoning-capable model. [LM Studio](https://lmstudio.ai/) is the default (port 1234).
- **CORS:** The browser app (Vite dev on port 5173) fetches from the LLM provider on a different port, so the provider must serve CORS headers. LM Studio enables CORS by default.

Provider URLs are configured in `config.js` — edit the `url` field in each model entry.

---

## Development

```bash
npm install

# Start Vite dev server
npm run dev

# Run tests (Node built-in test runner)
npm test                 # 64 tests, 15 suites

# Type-check JavaScript with TypeScript (strict mode)
npm run typecheck

# Production build
npm run build

# Preview production build locally
npm run preview
```

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  UI Layer (renders DOM, handles user events)         │
│  prompt-selector  mode-toggle  column  history       │
│  debug-overlay                                       │
├──────────────────────────────────────────────────────┤
│  Session Layer (coordinates state across models)     │
│  orchestrator → channel-pipeline (per model)         │
│  event-bus  storage (localStorage + adapter seam)    │
├──────────────────────────────────────────────────────┤
│  TTS Layer (text → audio streaming)                  │
│  kyutai-backend (WebSocket → MLX server)             │
│  tts-engine (streaming interface)                    │
│  text-chunker (optional prosody fallback)            │
├──────────────────────────────────────────────────────┤
│  Audio Layer (Web Audio API + visualization)         │
│  audio-graph (channels + ducking)                    │
│  waveform (canvas analyser viz)                      │
├──────────────────────────────────────────────────────┤
│  LLM Layer (streaming inference)                     │
│  llm-stream  providers/ (OpenAI-compatible SSE)      │
│  health-check                                        │
├──────────────────────────────────────────────────────┤
│  Config & Utilities                                  │
│  config.js  getReasoningContent.js  saveReasoning.js │
└──────────────────────────────────────────────────────┘

External processes:
  LM Studio (port 1234)     — LLM inference
  Python+MLX server (8765)  — Kyutai DSM TTS via WebSocket
```

---

## Project Structure

| File | Responsibility |
|---|---|
| `index.html` | Root HTML + loading spinner |
| `index.js` | App bootstrap: wire UI → Orchestrator → AudioGraph |
| `config.js` | Static config: models, voices, prompts, TTS params |
| `ui/prompt-selector.js` | Curated cards + free-text input + Ask button |
| `ui/mode-toggle.js` | Chorus / Monologue toggle |
| `ui/column.js` | Per-model text stream + waveform lifecycle |
| `ui/history.js` | Session history panel |
| `ui/debug-overlay.js` | Togglable pipeline diagnostics (TTS latency, audio chunks, token counts, errors) |
| `styles/` | Global CSS (reset, variables, animations, top-bar) |
| `ui/*.css` | Per-component styling |
| `session/orchestrator.js` | Session lifecycle coordinator (Loading → Checking → Thinking → Speaking → Done) |
| `session/channel-pipeline.js` | Per-model pipeline: LLM tokens → TTS → audio channel |
| `session/event-bus.js` | Observable state events (pub-sub) |
| `session/storage.js` | Session persistence with adapter seam |
| `tts/kyutai-backend.js` | WebSocket client for local MLX TTS server (auto-reconnect, event emission) |
| `tts/tts-engine.js` | Abstract streaming TTS interface (`load`, `startStream`, `stop`, `destroy`) |
| `tts/text-chunker.js` | Optional word accumulator for prosody tuning (punctuation/timeout/max-words flush) |
| `server/tts-server.py` | Python+MLX WebSocket server with Mimi codec |
| `server/test_server.py` | Standalone integration test for the TTS server |
| `audio/audio-graph.js` | Web Audio routing + ducking + streaming PCM playback |
| `audio/waveform.js` | Canvas visualization from AnalyserNode |
| `llm/llm-stream.js` | Backward-compatible SSE streaming wrapper |
| `llm/providers/` | Abstract LLMProvider + OpenAI-compatible SSE implementation |
| `llm/health-check.js` | Provider reachability ping |
| `test/` | Node test runner suites (64 tests, 15 suites) |
| `docs/adr/` | Architectural Decision Records |
