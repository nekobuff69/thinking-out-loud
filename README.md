# Thinking Out Loud

Ask questions and hear multiple LLMs reason out loud, with TTS voice synthesis.

## Prerequisites

- **Node.js 18+** (required for `node:test` and ES modules)
- **An OpenAI-compatible LLM provider** running locally with at least one reasoning-capable model loaded. [LM Studio](https://lmstudio.ai/) is the default (port 1234).
- **CORS:** The browser app (Vite dev on port 5173) fetches from the LLM provider on a different port, so the provider **must serve CORS headers**.
  - **LM Studio:** CORS is enabled by default in recent versions. If requests are blocked, relaunch with `--cors` or enable "Serve on Local Network" in Settings.
  - **Other providers (Ollama, etc.):** configure the server to include `Access-Control-Allow-Origin: *` or a matching origin.
- **First run:** the TTS model (~21MB quantized ONNX) downloads into the browser's IndexedDB cache. Subsequent loads are instant.

The provider URLs are configured in `config.js` — edit the `url` field in each model entry to point at your local server.

## Development

```bash
npm install

# Start Vite dev server
npm run dev

# Run tests (Node built-in test runner)
npm test

# Type-check JavaScript with TypeScript
npm run typecheck

# Production build
npm run build

# Preview production build locally
npm run preview
```

## Project Structure

- `index.html` — Root HTML + loading spinner element
- `index.js` — App bootstrap, loading spinner logic
- `config.js` — Static config: LLM models, curated prompts, TTS params
- `ui/` — UI components (prompt selector, mode toggle, columns, history) + per-component CSS
- `styles/` — Global CSS (reset, variables, spinner animation) and top-bar CSS
- `audio/` — Audio graph (Web Audio API) and waveform visualization (canvas)
- `tts/` — Text-to-speech engine (Kokoro backend via kokoro-js)
- `llm/` — LLM streaming (SSE), provider health checks, and provider abstraction (`llm/providers/`)
- `session/` — Orchestrator, channel pipeline, event bus, storage (localStorage + adapter seam)
- `tts/` — Text-to-speech engine (`TTSEngine` interface, Kokoro backend, sentence buffer, playback queue)
- `test/` — Node test runner suites (35 tests, 8 suites)
- `docs/` — ADRs and agent operating instructions
