# Thinking Out Loud — Project Context

> A browser-based art installation: ask a philosophical question, watch three local LLMs reason aloud in real time, with synchronized TTS audio and live waveform visualizations.

## Purpose

"Thinking Out Loud" makes machine reasoning audible and visible. When the user asks a question, three local LLMs (Qwen, Gemma, GPT-OSS) stream their internal reasoning tokens simultaneously. Each model's reasoning is synthesized to speech in a distinct voice, spatially panned across stereo channels, with live waveform visualizations. The final answers are suppressed — only the thinking is shown and heard.

## Tech Stack

- **Runtime:** Browser (ES modules)
- **Build:** Vite dev server + production bundler
- **LLM Inference:** OpenAI-compatible local providers (LM Studio, etc.) via `fetch()` + SSE
- **TTS:** Kokoro-82M via `kokoro-js` (official wrapper around `StyleTextToSpeech2Model`, quantized ONNX in browser IndexedDB)
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
│  ├── tts/kokoro-backend.js    kokoro-js (StyleTextToSpeech2)│
│  ├── tts/tts-engine.js        Abstract interface            │
│  ├── tts/sentence-buffer.js   Token → sentence boundaries   │
│  └── tts/playback-queue.js    Sentence → audio queue        │
├─────────────────────────────────────────────────────────────┤
│  Audio Layer (Web Audio routing + visualization)            │
│  ├── audio/audio-graph.js     AudioContext + channels       │
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
  1. Load TTS model (KokoroBackend.load)
  2. Health-check all LLM providers (/models ping)
  3. For each reachable model:
     • Create ChannelPipeline
     • ChannelPipeline.createChannel() → AudioGraph channel + waveform
  4. Create an `LLMProvider` per model (`OpenAICompatibleProvider`)
  5. Fire all LLM streams concurrently via `LLMProvider.streamReasoning()`
     • Tokens → ChannelPipeline.feedToken() → Column.appendToken()
     • Sentence boundaries → SentenceBuffer (bundles 2 sentences) → TTSPlaybackQueue.enqueue()
     • Pre-synthesis: next sentence is synthesized during current playback
     • TTS synthesis → AudioGraph channel.play() → waveform animates
     • State events → EventBus → DebugOverlay (when enabled)
  5. When all streams end + all TTS idle → save session → Done
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
  • ChannelPipeline.drainText(storedReasoning)  (feeds text with visual delay)
  • SentenceBuffer → TTSPlaybackQueue → AudioGraph (same as live)
```

## Key Module Interfaces

### ChannelPipeline (`session/channel-pipeline.js`)

Owns one Model's entire pipeline end-to-end. The Orchestrator delegates to it.

```
new ChannelPipeline({ model, ttsConfig, column, ttsEngine, llmProvider, audioGraph, onIdle, eventBus })
  .createChannel()                    // Creates audio channel + waveform
  .startStream(systemPrompt, question, signal?)  // → Promise (LLM → TTS)
  .drainText(text)                    // Replay stored reasoning
  .feedToken(token)                   // Manual token injection
  .softStop()                         // Abort stream + stop queue
  .flush()                            // Flush remaining buffer
  .pause() / .resume()                // Control TTS queue
  .isActive / .isCapped / .reasoningText  // Getters
```

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

### TTSPlaybackQueue (`tts/playback-queue.js`)

Explicit state machine with **pre-synthesis**: while sentence N plays, sentence N+1 is synthesized on the main thread and stored in `#nextBuffer` for gap-free playback.

```
State machine: Idle → Synthesizing → Playing → Gapping → Idle
                ↑_________________________________________↓
                (with pre-synthesis happening during Playing)

.enqueue(text)   // Add sentence to queue; kicks off pre-synthesis
.pause()         // Hold current position (pre-synthesis continues)
.resume()        // Continue from pause
.stop()          // Soft stop: finish current, discard rest
.isActive        // Any pending or in-flight work?
.isPaused        // Currently paused?
.state           // Current state name
.depth           // Queue depth + pre-baked buffer count
```

**Key behaviors:**
- First sentence always incurs synthesis delay
- Every subsequent sentence plays immediately from pre-baked buffer
- Sentence gap reduced to **50ms**
- Pre-synthesis continues even while paused (supports Monologue seamless transitions)

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
bus.on("token", (data) => { ... });          // { modelName, token }
bus.on("buffer-state", (data) => { ... });   // { modelName, tokenCount, wordCount, sentencesHeld, capped }
bus.on("queue-state", (data) => { ... });    // { modelName, depth, state }
bus.on("synth-timing", (data) => { ... });   // { modelName, timingMs }
bus.on("pipeline-progress", (data) => { ... }); // { modelName, stage }
bus.on("pipeline-error", (data) => { ... }); // { modelName, message, timestamp }
bus.emit("token", { modelName: "Qwen", token: "h" });
```

### DebugOverlay (`ui/debug-overlay.js`)

Togglable diagnostics panel. Enabled via `?debug` query parameter or `` ` `` / `Ctrl+Shift+D` keyboard shortcut.

- **Per-model:** token rate, buffer state (tokens + word count, sentences held), queue state, synthesis timing, pipeline progress, error logs
- **Global:** session state, aggregate token rates
- Styled as a semi-transparent fixed panel that does not interfere with the main UI

### AudioGraph (`audio/audio-graph.js`)

Shared AudioContext with per-model channels and automatic ducking.

```
new AudioGraph()
  .getContext()           // Lazy AudioContext
  .createChannel(pan)     // { play(buffer, onEnd), analyser, gain, stopAll }
  .clearChannels()        // Disconnect all, stop audio
  .destroy()              // Close AudioContext
  .enableTabResume()      // Handle visibilitychange
  .activeCount            // Currently playing channels
```

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
  │         └─► (download TTS model, show spinner)
  │
  └─── Stop ──► Done ──► Idle (soft stop: abort streams, finish current TTS, silence)
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
| `session/channel-pipeline.js` | Per-model pipeline (buffer→queue→channel) | Deep |
| `session/event-bus.js` | Observable state events (pub-sub) | Shallow |
| `session/storage.js` | Session persistence with adapter seam | Deep |
| `session/local-storage-adapter.js` | localStorage wrapper | Shallow |
| `session/memory-storage-adapter.js` | In-memory adapter for tests | Shallow |
| `tts/kokoro-backend.js` | kokoro-js TTS backend (StyleTextToSpeech2Model + resampling) | Deep |
| `tts/tts-engine.js` | Abstract TTS interface | Shallow (interface) |
| `tts/sentence-buffer.js` | Token accumulation + two-sentence bundling + boundary detection | Deep |
| `tts/playback-queue.js` | TTS state machine with pre-synthesis (6 explicit states) | Deep |
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
| `test/` | Node test runner suites (35 tests, 8 suites) | Shallow (test) |
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
| `sentence-buffer.test.js` | 9 | Two-sentence bundling, total-token cap, timeout flush, per-sentence reset |
| `health-check.test.js` | 4 | URL construction with/without trailing slashes, fetch errors |
| `llm-stream.test.js` | 4 | Endpoint construction with/without trailing slashes |
| `openai-compatible-provider.test.js` | 9 | Separate/tagged/none reasoning formats, URL construction, retry, abort |
| `orchestrator.test.js` | 1 | stop() → Idle transition after manual stop |
| `channel-pipeline.test.js` | 1 | Empty LLM stream → setError on column |
| `playback-queue.test.js` | 7 | Pre-synthesis, gap-free playback, paused pre-synthesis, soft stop |

### Testable modules (for new tests)

- `llm/llm-stream.js` — Mock `fetch` with ReadableStream SSE responses
- `llm/providers/openai-compatible-provider.js` — Mock `fetch` with SSE; test reasoningFormat modes
- `tts/playback-queue.js` — Mock TTS engine and channel
- `session/channel-pipeline.js` — Mock all dependencies
- `session/storage.js` — Inject MemoryStorageAdapter
- `session/event-bus.js` — Pure logic, no mocks needed
- `tts/sentence-buffer.js` — Pure logic, no mocks needed
- `llm/health-check.js` — Mock global `fetch`

## Known Extension Points

| Extension | How | Files |
|---|---|---|
| New LLM provider | Implement `LLMProvider` interface; update `config.js` | `llm/providers/`, `config.js` |
| New TTS backend | Extend `TTSEngine` | `tts/tts-engine.js` |
| New storage backend | Implement adapter interface | `session/storage.js` |
| IndexedDB storage | New adapter + inject | `session/storage.js` |
| New playback mode | Add state logic to Orchestrator | `session/orchestrator.js` |
| Config validation | Add schema check before bootstrap | `config.js`, `index.js` |
