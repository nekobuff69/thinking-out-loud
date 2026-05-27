# Thinking Out Loud — Project Context

> A browser-based art installation: ask a philosophical question, watch three local LLMs reason aloud in real time, with synchronized TTS audio and live waveform visualizations.

## Purpose

"Thinking Out Loud" makes machine reasoning audible and visible. When the user asks a question, three local LLMs (Qwen, Gemma, GPT-OSS) stream their internal reasoning tokens simultaneously. Each model's reasoning is displayed in real time. The reasoning text is synthesized to speech sequentially — voices speak one at a time in a random order per session — each in a distinct voice spatially panned across stereo channels with live waveform visualizations. The final answers are suppressed — only the thinking is shown and heard.

## Tech Stack

- **Runtime:** Browser (ES modules)
- **Build:** Vite dev server + production bundler
- **LLM Inference:** OpenAI-compatible local providers (LM Studio, etc.) via `fetch()` + SSE
- **TTS:** Pocket TTS (100M params, CPU-only) via local Python server. Streaming WAV audio over HTTP (`POST /v1/tts` with `{text, voice}`). Voice cloning from any WAV file via `get_state_for_audio_prompt()`. Sentence-level text input, ~200ms first-audio latency.
- **TTS Protocol:** HTTP request/response (`POST /v1/tts` → streaming WAV) for live sessions; legacy single-shot `synthesize` protocol preserved for replay.
- **TTS Reference:** See ADR-005 (`docs/adr/005-pocket-tts-switch.md`). Upstream: [Pocket TTS](https://github.com/kyutai-labs/pocket-tts), [CALM paper](https://arxiv.org/abs/2509.06926).
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

│  ├── ui/column.js               Per-model text + waveform   │
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
│  ├── tts/pocket-tts-backend.js  HTTP client for Pocket TTS  │
│  ├── tts/tts-engine.js          Streaming interface          │
│  ├── tts/text-chunker.js        Sentence-boundary accumulator│
│  ├── server/tts-server-pocket.py  Pocket TTS HTTP server     │
│  ├── server/test_server_pocket.py  Server integration tests  │
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
|  ├── config.js                Models, prompts, TTS config (chunker params) |
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
index.js ──► orchestrator.start(question)
  │
  ▼
Orchestrator:
  1. Ensure TTS server is running (HTTP health check to Pocket TTS server)
  2. Health-check all LLM providers (/models ping)
  3. For each reachable model:
     • Create ChannelPipeline (with per-model PocketTtsBackend injected)
     • ChannelPipeline.createChannel() → AudioGraph channel + waveform
     • Models are shuffled into random playback order
     • All pipelines created — only first in shuffled order feeds TTS initially;
       the rest are paused
  4. Fire all LLM streams concurrently via `LLMProvider.streamReasoning()`
     • Tokens → ChannelPipeline.feedToken() → Column.appendToken() all 3 models
     • Only the active pipeline feeds TTS: TextChunker splits reasoning on
       punctuation (`.!?;,` configurable), max words (15), or silence
       timeout (2000ms, min 3 words). Each sentence sent via HTTP POST.
     • Each sentence → PocketTtsBackend.startStream() → POST /v1/tts →
       server generates streaming WAV audio
     • PCM frames stream back over HTTP → AudioGraph channel → waveform animates
     • When active pipeline's TTS finishes → orchestrator advances to next
     • Next pipeline resumes → sends full accumulated reasoningText to TTS → speaks
     • Repeats until all pipelines have spoken
     • Content boundary / LLM end / token cap → send remaining text + finish
     • State events → EventBus → DebugOverlay (when enabled)
  5. When last pipeline's TTS finishes → save session → Done
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
  .drainText(text)                    // Replay stored reasoning (legacy synthesize protocol)
  .feedToken(token)                   // Token injection → TextChunker → sentence queue
  .softStop()                         // Abort HTTP requests + stop audio. Backend stays alive.
  .pause() / .resume()                // Pause/resume TTS feeding (sequential playback)
  .isActive / .isCapped / .reasoningText  // Getters
```


**Text feeding (live path):** Tokens route through TextChunker, which flushes on
punctuation (`.` `!` `?` `;` `,` — configurable), max words (default 15), or silence timeout
(2000ms, min 3 words). Each flushed chunk enters the `#sentenceQueue` and is sent as a
separate HTTP POST via `PocketTtsBackend.startStream()`. Sentences play sequentially
— next starts only after current `onDone`. A single audio stream (`openStream()`) is
reused across all sentences. Paused pipelines skip TTS feeding; `resume()` re-feeds the
full accumulated `#reasoningText` through the TextChunker.
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

### PocketTtsBackend (`tts/pocket-tts-backend.js`)

HTTP client for the local Pocket TTS server. One instance per model (3 total).
Handles text as complete sentences via `startStream()`. No incremental text feeding
— sentences are split by TextChunker before reaching the backend.

**API:**
```js
load() → Promise<void>              // Verify server reachable (HTTP health check)
startStream(text, voice, onAudioChunk, {onDone, onError}) → void
  // Sends POST /v1/tts with {text, voice}, receives streaming WAV
stop() → void                       // Abort current request
destroy()                           // Release resources
```

- `startStream()` sends `POST /v1/tts` with `{text, voice}`, returns immediately.
  PCM chunks arrive via `onAudioChunk(Float32Array, sampleRate)`.
- Debug events to EventBus: `tts-connect`, `tts-disconnect`, `tts-first-audio` (ms),
  `tts-text-sent`, `tts-done`, `tts-error`.

**Replay path:** Same `startStream()` API, same HTTP endpoint.
Used by `ChannelPipeline.drainText()`.
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
bus.on("tts-text-sent", (data) => { ... });     // { modelName, chars, words }
bus.on("tts-done", (data) => { ... });          // { modelName }
bus.on("tts-error", (data) => { ... });         // { modelName, message }
bus.on("tts-reconnect", (data) => { ... });     // { modelName } — TTS reconnected, audio re-init
bus.on("tts-text-dropped", (data) => { ... });  // { modelName, reason, chars } — text lost to closed stream
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
AudioBufferSourceNode from PCM data — called asynchronously from HTTP response stream.
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
  │         └─► (HTTP health check to Pocket TTS server)
  │
  └─── Stop ──► Done ──► Idle (immediate kill: abort HTTP requests, stop audio, fresh slate)
```

## File Inventory

| File | Responsibility | Depth |
|---|---|---|
| `index.html` | Root HTML + loading spinner element | Shallow (markup) |
| `index.js` | Bootstrap: wire UI → Orchestrator → AudioGraph, loading spinner | Shallow (wiring) |
| `config.js` | Static config: models, prompts, TTS params | Shallow (data) |
| `ui/prompt-selector.js` | Curated cards + free-text + Ask button, keyboard a11y | Deep |
| `ui/prompt-selector.css` | Prompt cards + input styling | Shallow (style) |

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
| `tts/pocket-tts-backend.js` | HTTP client for Pocket TTS server (live + replay API, debug events) | Deep |
| `tts/tts-engine.js` | Abstract TTS streaming interface | Shallow (interface) |
| `tts/text-chunker.js` | Sentence/clause accumulator with configurable punctuation, max words, and silence timeout | Shallow |
| `server/tts-server-pocket.py` | Pocket TTS HTTP server (FastAPI, streaming WAV response, voice cloning) | Deep |
| `server/test_server_pocket.py` | Python integration tests for Pocket TTS server | Shallow (test) |
| `server/requirements.txt` | Python server dependencies (pocket-tts, fastapi, uvicorn, numpy, scipy) | Shallow (config) |
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
| `test/` | Node test runner suites (91 tests, 14 suites) | Shallow (test) |
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
| `orchestrator.test.js` | 3 | stop() → Idle transition, no-save after stop, monologue sequencing |
| `channel-pipeline.test.js` | 17 | Empty LLM stream detection, sentence streaming, sequential playback, token cap, content boundary, softStop isolation, reconnect recovery, resume/replay, replay guard |
| `audio-graph-stream.test.js` | 7 | playStream PCM playback, scheduling, ducking, stop; openStream feed/end/stop/ducking |
| `text-chunker.test.js` | 18 | Punctuation (incl. comma), max-words, timeout, min-words guard, disabled punctuation, manual/reset |

### Testable modules (for new tests)

- `llm/llm-stream.js` — Mock `fetch` with ReadableStream SSE responses
- `llm/providers/openai-compatible-provider.js` — Mock `fetch` with SSE; test reasoningFormat modes
- `tts/pocket-tts-backend.js` — Mock HTTP server; test chunk delivery
- `session/channel-pipeline.js` — Mock all dependencies
- `session/storage.js` — Inject MemoryStorageAdapter
- `session/event-bus.js` — Pure logic, no mocks needed
- `llm/health-check.js` — Mock global `fetch`

## Known Extension Points

| Extension | How | Files |
|---|---|---|
| New LLM provider | Implement `LLMProvider` interface; update `config.js` | `llm/providers/`, `config.js` |
| New TTS backend | Extend `TTSEngine` | `tts/tts-engine.js`, `tts/pocket-tts-backend.js` |
| New storage backend | Implement adapter interface | `session/storage.js` |
| IndexedDB storage | New adapter + inject | `session/storage.js` |
| New playback mode | Add state logic to Orchestrator | `session/orchestrator.js` |
| Config validation | Add schema check before bootstrap | `config.js`, `index.js` |

## TTS Stack References

| Resource | Link |
|---|---|
| Pocket TTS repository | <https://github.com/kyutai-labs/pocket-tts> |
| CALM architecture paper | <https://arxiv.org/abs/2509.06926> |
| Pocket TTS demo | <https://kyutai.org/pocket-tts> |
| Pocket TTS technical report | <https://kyutai.org/pocket-tts-technical-report> |
| Pocket TTS switch ADR | `docs/adr/005-pocket-tts-switch.md` |
| TTS technology evaluation | `docs/tts-technology-evaluation.md` |