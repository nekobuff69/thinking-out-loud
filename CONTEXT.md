# Thinking Out Loud — Project Context

> A browser-based art installation: ask a philosophical question, watch three local LLMs reason aloud in real time, with synchronized TTS audio and live waveform visualizations.

## Purpose

"Thinking Out Loud" makes machine reasoning audible and visible. When the user asks a question, three local LLMs (Qwen, Gemma, GPT-OSS) stream their internal reasoning tokens simultaneously. Each model's reasoning is synthesized to speech in a distinct voice, spatially panned across stereo channels, with live waveform visualizations. The final answers are suppressed — only the thinking is shown and heard.

## Tech Stack

- **Runtime:** Browser (ES modules)
- **Build:** Vite dev server + production bundler
- **LLM Inference:** OpenAI-compatible local providers (LM Studio, etc.) via `fetch()` + SSE
- **TTS:** Kyutai DSM TTS via local Python+MLX server (`moshi-mlx`), streamed over WebSocket. Mimi codec, 1.6B params, Apple Silicon optimized. Uses incremental text feeding via `TTSGen` for smooth, low-latency speech. Per-model WebSocket connections (3 total).
- **TTS Protocol:** Streaming protocol (`open_stream` → `text`(×N) → `close_stream`) for live sessions; legacy single-shot `synthesize` protocol preserved for replay.
- **TTS Reference:** See `docs/adr/004-streaming-tts-protocol.md` for protocol design. Upstream references: [Kyutai TTS blog](https://kyutai.org/blog/2025-07-03-kyutai-tts-1-6b#delayed-streams-modeling), [streaming MLX example](https://github.com/kyutai-labs/delayed-streams-modeling/blob/main/scripts/tts_mlx_streaming.py), [DSM paper](https://arxiv.org/html/2509.08753v2).
- **Audio:** Web Audio API (AudioContext, GainNode, StereoPannerNode, AnalyserNode)
- **Storage:** localStorage with adapter seam (in-memory for tests)
- **Styling:** Separate CSS files in `styles/` and `ui/`, imported as ES modules

## Module Map

### Entry Point

```
index.html ──► index.js (bootstraps everything)
```

### Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  UI Layer (renders DOM, handles user events)                │
│  ├── ui/prompt-selector.js    Ask button, curated prompts   │
│  ├── ui/mode-toggle.js        Chorus / Monologue switch     │
│  ├── ui/column.js             Per-model text + waveform     │
│  ├── ui/history.js            Past sessions panel           │
│  └── ui/debug-overlay.js      Togglable pipeline diagnostics  │
├─────────────────────────────────────────────────────────────┤
│  Session Layer (coordinates state across models)            │
│  ├── session/orchestrator.js  Session lifecycle coordinator │
│  ├── session/channel-pipeline.js  Per-model full pipeline   │
│  ├── session/event-bus.js     Observable state events       │
│  ├── session/storage.js       SessionStore persistence      │
│  ├── session/local-storage-adapter.js  Production adapter   │
│  └── session/memory-storage-adapter.js  Test adapter        │
├─────────────────────────────────────────────────────────────┤
│  TTS Layer (text → audio synthesis + playback)              │
│  ├── tts/kyutai-backend.js    Per-model WebSocket client    │
│  ├── tts/tts-engine.js        Streaming interface           │
│  ├── tts/text-chunker.js      Word-boundary accumulator     │
│  ├── server/tts-server.py     Legacy single-shot server     │
│  └── server/tts-server-streaming.py  Streaming TTSGen server│
├─────────────────────────────────────────────────────────────┤
│  Audio Layer (Web Audio routing + visualization)            │
│  ├── audio/audio-graph.js     AudioContext + channels       │
│  │   ├── playStream(streamFn)   Legacy: replay playback     │
│  │   └── openStream()           New: live async PCM feed    │
│  └── audio/waveform.js        Canvas analyser viz           │
├─────────────────────────────────────────────────────────────┤
│  LLM Layer (streaming inference)                            │
│  ├── llm/llm-stream.js        Backward-compat wrapper       │
│  ├── llm/providers/llm-provider.js   Abstract interface     │
│  ├── llm/providers/openai-compatible-provider.js  Default impl│
│  └── llm/health-check.js      /models ping for reachability │
├─────────────────────────────────────────────────────────────┤
│  Config & Utilities                                         │
│  ├── config.js                Models, prompts, TTS config   │
│  ├── getReasoningContent.js   Standalone reasoning fetcher  │
│  ├── saveReasoning.js         Standalone reasoning saver    │
│  └── normalizeModelName.js    Slugify model names           │
└─────────────────────────────────────────────────────────────┘
```

## Data Flow

### Normal Session (Ask → Thinking → Speaking → Done)

```
User clicks Ask
  │
  ▼
index.js ──► orchestrator.start(question, mode)
  │
  ▼
Orchestrator:
  1. Ensure TTS server is running (WebSocket ping to streaming server)
  2. Health-check all LLM providers (/models ping)
  3. For each reachable model:
     • Open per-model WebSocket to TTS server (3 connections total)
     • Create ChannelPipeline (with per-model KyutaiBackend injected)
     • ChannelPipeline.createChannel() → AudioGraph channel (openStream mode) + waveform
  4. Fire all LLM streams concurrently via `LLMProvider.streamReasoning()`
     • Tokens → ChannelPipeline.feedToken() → Column.appendToken()
     • Pipeline accumulator builds #unsentBuffer, sends incremental text deltas
       on word boundaries (first chunk: 50ms timeout for fast first audio)
     • Each text chunk → KyutaiBackend.sendText() → WebSocket text message →
       server appends entries to TTSGen → generates PCM frames
     • PCM frames push back over WebSocket → AudioGraph channel.openStream().feed()
       → AudioBufferSourceNodes → waveform animates
     • Content boundary / LLM end / token cap → send remaining delta + close stream
     • Server drains remaining entries + tail padding → sends done
     • State events → EventBus → DebugOverlay (when enabled)
  5. When all streams end + all TTS done → save session → Done
```

### Replay (History click)

```
User clicks past session in history panel
  │
  ▼
orchestrator.replay(sessionData)
  │
  ▼
For each stored model reasoning:
  • Create fresh ChannelPipeline + Channel
  • ChannelPipeline.drainText(storedReasoning) sends full text via
    legacy single-shot synthesiz protocol + playStream(streamFn) audio mode
```

## Key Module Interfaces

### ChannelPipeline (`session/channel-pipeline.js`)

Owns one Model's entire pipeline end-to-end. The Orchestrator delegates to it.

```
new ChannelPipeline({ model, ttsConfig, column, ttsBackend, llmProvider, audioGraph, onIdle, eventBus })
  .createChannel()                    // Creates audio channel (openStream mode) + waveform
  .startStream(systemPrompt, question, signal?)  // → Promise (LLM → incremental TTS)
  .drainText(text)                    // Replay stored reasoning (uses legacy synthesiz protocol)
  .feedToken(token)                   // Manual token injection → accumulator → sendText()
  .softStop()                         // Close stream + kill WebSocket immediately (fresh slate)
  .pause() / .resume()                // Stop/start sendText() calls (monologue sequencing)
  .isActive / .isCapped / .reasoningText  // Getters
```

**Text feeding (live path):** Tokens accumulate in `#unsentBuffer`. On word boundary (whitespace
or sentence-ending punctuation), or first-chunk 50ms timeout, the buffer contents are sent as
a `text` WebSocket message via the backend's stream handle. The buffer is then cleared
(drain-on-send). Token cap stops `sendText()` calls and closes the stream; server continues
generating from already-queued entries.

**Replay path:** `drainText()` uses the legacy `startStream(fullText, voice, ...)` API and
`playStream(streamFn)` audio mode — no incremental protocol needed for pre-recorded text.

### LLMProvider (`llm/providers/llm-provider.js`)

Abstract interface for LLM streaming. Concrete implementations hide fetch → SSE parse → callback pipeline.

```js
// OpenAICompatibleProvider is the default implementation
const provider = new OpenAICompatibleProvider({ url, model, reasoningFormat });
await provider.streamReasoning(
  question,
  systemPrompt,
  {
    onReasoningToken: (token) => {},
    onContentStart: () => {},       // Content boundary reached
    onDone: () => {},
  },
  signal
);
```

**Reasoning formats:**
- `"separate"` (default): reads `delta.reasoning_content` / `delta.reasoning`
- `"tagged"`: extracts reasoning from `<think>...</think>` tags inside `delta.content`
- `"none"`: treats all `delta.content` as reasoning

`llm/llm-stream.js` preserves a backward-compatible `streamReasoning()` wrapper.

### KyutaiBackend (`tts/kyutai-backend.js`)

WebSocket client for the local Python+MLX TTS server. One instance per model (3 total) —
each owns one WebSocket connection. Stays a dumb protocol pipe: translates method calls
to JSON messages, routes PCM frames to callbacks. No text processing.

**Live streaming API (new):**
```js
load() → Promise<void>              // Open WebSocket (idempotent)
openStream(voice, {onAudioChunk, onDone, onError}) → StreamHandle
  stream.sendText(text)             // Send text chunk (incremental delta)
  stream.close()                    // Signal end of text
destroy()                           // Close WebSocket, prevent reconnect
```

- `openStream()` sends `{"type":"open_stream","voice":"..."}`, returns immediately.
  Only one active stream per backend.
- `sendText()` sends `{"type":"text","data":"..."}` — appends entries on server.
- `close()` sends `{"type":"close_stream"}` — server drains remaining entries.
- Debug events to EventBus: `tts-connect`, `tts-disconnect`, `tts-first-audio` (ms),
  `tts-text-sent`, `tts-queue` (entries queued), `tts-done`, `tts-error`.

**Legacy single-shot API (preserved for replay only):**
```js
startStream(fullText, voice, onAudioChunk, {onDone, onError}) → void
stop() → void
```

Used only by `ChannelPipeline.drainText()`. Sends `{"type":"synthesize",...}` message.
Compatible with legacy `tts-server.py`.

### SessionStore (`session/storage.js`)

Persistence with adapter seam at construction time.

```js
const store = new SessionStore(maxSessions = 20, storageAdapter?);
store.save(session);      // Evicts oldest if over limit
store.load(id);           // Single session or null
store.list();             // Newest first
store.clear();            // Remove all
store.saveQuestion(text); // Deduplicated recent questions
store.getQuestions();     // Recent question list
```

### SimpleEventBus (`session/event-bus.js`)

Lightweight observer for cross-module state observation. Pipeline modules emit events; the debug overlay (or any listener) subscribes. No producer knows about its consumers.

```js
const bus = new SimpleEventBus();
bus.on("token", (data) => { ... });             // { modelName, token }
bus.on("tts-chunk", (data) => { ... });         // { modelName, bytesReceived }
bus.on("tts-first-chunk", (data) => { ... });   // { modelName, latencyMs }
bus.on("pipeline-progress", (data) => { ... }); // { modelName, stage }
bus.on("pipeline-error", (data) => { ... });    // { modelName, message, timestamp }
bus.emit("token", { modelName: "Qwen", token: "h" });
```

### DebugOverlay (`ui/debug-overlay.js`)

Togglable diagnostics panel. Enabled via `` ` `` / `Ctrl+Shift+D` keyboard shortcut.

See `docs/debug-overlay-reference.md` for complete event-to-display mapping.

- **Per-model:** TTS connection state, time-to-first-chunk (ms), pipeline progress, error logs
- **Global:** session state, per-model token counts
- Styled as a semi-transparent fixed panel that does not interfere with the main UI

### AudioGraph (`audio/audio-graph.js`)

Shared AudioContext with per-model channels and automatic ducking.

```js
new AudioGraph()
  .getContext()           // Lazy AudioContext
  .createChannel(pan)     // Returns Channel object:
  .clearChannels()        // Disconnect all, stop audio
  .destroy()              // Close AudioContext
  .enableTabResume()      // Handle visibilitychange
  .activeCount            // Currently playing channels

// Channel object methods:
channel.play(buffer, onEnd)          // Play single AudioBuffer
channel.playStream(streamFn)         // Legacy: replay playback (sync streamFn)
channel.openStream()                 // New: live async PCM feed
  → { feed(pcm, sampleRate), end(), stop() }
channel.analyser / channel.gain / channel.stopAll
```

**`openStream()` mode (live path):** `feed(pcm, sampleRate)` creates and schedules an
AudioBufferSourceNode from PCM data — called asynchronously from WebSocket `onmessage`.
`end()` signals no more frames coming. `stop()` kills all sources immediately.
Shares ducking and `activeCount` with `playStream`.

## Session State Machine

Managed by Orchestrator. All state transitions flow through `orchestrator.onStateChange()`.

```
Idle ──► Loading ──► Checking ──► Thinking ──► Speaking ──► Done ──► Idle
  │         │           │             │            │
  │         │           │             │            └─► (save to SessionStore, reset)
  │         │           │             │
  │         │           │             └─► (all streams ended, TTS still playing)
  │         │           │
  │         │           └─► (health-check providers)
  │         │
  │         └─► (connect to TTS server via WebSocket ping)
  │
  └─── Stop ──► Done ──► Idle (immediate kill: close streams, kill WebSocket, fresh slate)
```

## File Inventory

| File | Responsibility | Depth |
|---|---|---|
| `index.html` | Root HTML + loading spinner element | Shallow (markup) |
| `index.js` | Bootstrap: wire UI → Orchestrator → AudioGraph, loading spinner | Shallow (wiring) |
| `config.js` | Static config: models, prompts, TTS params | Shallow (data) |
| `ui/prompt-selector.js` | Curated cards + free-text + Ask button, keyboard a11y | Deep |
| `ui/prompt-selector.css` | Prompt cards + input styling | Shallow (style) |
| `ui/mode-toggle.js` | Chorus/Monologue toggle, keyboard a11y | Deep |
| `ui/mode-toggle.css` | Toggle button styling | Shallow (style) |
| `ui/column.js` | Per-model text stream + waveform lifecycle | Deep |
| `ui/column.css` | Column layout + scrollbar styling | Shallow (style) |
| `ui/history.js` | Session history panel | Deep |
| `ui/history.css` | History sidebar styling | Shallow (style) |
| `styles/global.css` | CSS reset, variables, animations (spinner, pulse) | Shallow (style) |
| `styles/top-bar.css` | Header bar layout | Shallow (style) |
| `session/orchestrator.js` | Session state coordination | Deep |
| `session/channel-pipeline.js` | Per-model pipeline (LLM tokens → accumulator → incremental TTS → audio channel) | Deep |
| `session/event-bus.js` | Observable state events (pub-sub) | Shallow |
| `session/storage.js` | Session persistence with adapter seam | Deep |
| `session/local-storage-adapter.js` | localStorage wrapper | Shallow |
| `session/memory-storage-adapter.js` | In-memory adapter for tests | Shallow |
| `tts/kyutai-backend.js` | Per-model WebSocket client (live streaming + legacy replay API, auto-reconnect, debug events) | Deep |
| `tts/tts-engine.js` | Abstract TTS streaming interface | Shallow (interface) |
| `tts/text-chunker.js` | Word-boundary accumulator (drain-on-send, first-chunk timeout) | Shallow |
| `server/tts-server-streaming.py` | Python+MLX streaming server (TTSGen, cooperative round-robin, new protocol) | Deep |
| `server/tts-server.py` | Legacy single-shot Python+MLX server (preserved for replay fallback) | Deep |
| `server/requirements.txt` | Python server dependencies (moshi-mlx, websockets) | Shallow (config) |
| `audio/audio-graph.js` | Web Audio routing + ducking | Deep |
| `audio/waveform.js` | Canvas visualization from AnalyserNode | Deep |
| `llm/llm-stream.js` | Backward-compat wrapper around provider | Shallow |
| `llm/providers/llm-provider.js` | Abstract LLMProvider interface | Shallow (interface) |
| `llm/providers/openai-compatible-provider.js` | OpenAI-compatible SSE streaming with reasoningFormat | Deep |
| `llm/health-check.js` | Provider reachability ping | Shallow |
| `getReasoningContent.js` | Standalone reasoning fetcher (legacy utility) | Shallow |
| `saveReasoning.js` | Standalone reasoning saver (legacy utility) | Shallow |
| `normalizeModelName.js` | Slugify model names for directories | Shallow |
| `tsconfig.json` | TypeScript strict check-js config | Shallow (config) |
| `vite.config.js` | Vite dev/build config | Shallow (config) |
| `vite-env.d.ts` | Vite/CSS module type declarations | Shallow (types) |
| `.gitignore` | Ignored files (node_modules, .env, scratch) | Shallow (config) |
| `.env` | Legacy CLI script vars (not read by browser app) | Shallow (config) |
| `test/` | Node test runner suites (64 tests, 15 suites) | Shallow (test) |
| `ui/debug-overlay.js` | Togglable pipeline diagnostics panel | Deep |
| `ui/debug-overlay.css` | Debug overlay styling | Shallow (style) |

## Legacy Scripts

`getReasoningContent.js` and `saveReasoning.js` are standalone Node.js utilities for fetching and saving reasoning content to disk. They are NOT part of the browser application flow. They reuse `llm/llm-stream.js` for streaming and read config from `.env` (not `config.js`). `normalizeModelName.js` is a shared helper used by the legacy scripts to slugify model names for directory paths.

## Testing

Tests use Node.js built-in `node:test` (Node 18+) with `--experimental-test-module-mocks`. Run with:

```bash
npm test
```

### Test inventory (`test/`)

| File | Tests | What it covers |
|---|---|---|
| `health-check.test.js` | 4 | URL construction with/without trailing slashes, fetch errors |
| `llm-stream.test.js` | 4 | Endpoint construction with/without trailing slashes |
| `openai-compatible-provider.test.js` | 9 | Separate/tagged/none reasoning formats, URL construction, retry, abort |
| `orchestrator.test.js` | 1 | stop() → Idle transition after manual stop |
| `channel-pipeline.test.js` | 5 | Empty LLM stream detection, TTS streaming path, TextChunker integration, mono/pause/resume |
| `kyutai-backend.test.js` | 12 | WebSocket connection, streaming, PCM chunk ordering, reconnect, error handling |
| `audio-graph-stream.test.js` | 5 | playStream PCM playback, scheduling, ducking, stop |
| `text-chunker.test.js` | 16 | Punctuation/timeout/max-words flush, no-premature-flush, disabled punctuation

### Testable modules (for new tests)

- `llm/llm-stream.js` — Mock `fetch` with ReadableStream SSE responses
- `llm/providers/openai-compatible-provider.js` — Mock `fetch` with SSE; test reasoningFormat modes
- `tts/kyutai-backend.js` — Mock WebSocket server; test chunk delivery and reconnection
- `session/channel-pipeline.js` — Mock all dependencies
- `session/storage.js` — Inject MemoryStorageAdapter
- `session/event-bus.js` — Pure logic, no mocks needed
- `llm/health-check.js` — Mock global `fetch`

## Known Extension Points

| Extension | How | Files |
|---|---|---|
| New LLM provider | Implement `LLMProvider` interface; update `config.js` | `llm/providers/`, `config.js` |
| New TTS backend | Extend `TTSEngine` (both live and legacy APIs) | `tts/tts-engine.js`, `tts/kyutai-backend.js` |
| New storage backend | Implement adapter interface | `session/storage.js` |
| IndexedDB storage | New adapter + inject | `session/storage.js` |
| New playback mode | Add state logic to Orchestrator | `session/orchestrator.js` |
| Config validation | Add schema check before bootstrap | `config.js`, `index.js` |

## TTS Stack References

| Resource | Link |
|---|---|
| Kyutai TTS 1.6B blog post (DSM architecture) | <https://kyutai.org/blog/2025-07-03-kyutai-tts-1-6b#delayed-streams-modeling> |
| Streaming MLX reference implementation (`TTSGen`) | <https://github.com/kyutai-labs/delayed-streams-modeling/blob/main/scripts/tts_mlx_streaming.py> |
| DSM research paper | <https://arxiv.org/html/2509.08753v2> |
| `moshi-mlx` package (installed) | <https://pypi.org/project/moshi-mlx/> |
| Kyutai TTS voices repo | <https://huggingface.co/kyutai/tts-voices> |
| Streaming protocol ADR | `docs/adr/004-streaming-tts-protocol.md` |
