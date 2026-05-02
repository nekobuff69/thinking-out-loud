# Thinking Out Loud — Project Context

> A browser-based art installation: ask a philosophical question, watch three local LLMs reason aloud in real time, with synchronized TTS audio and live waveform visualizations.

## Purpose

"Thinking Out Loud" makes machine reasoning audible and visible. When the user asks a question, three local LLMs (Qwen, Nemotron, Mistral) stream their internal reasoning tokens simultaneously. Each model's reasoning is synthesized to speech in a distinct voice, spatially panned across stereo channels, with live waveform visualizations. The final answers are suppressed — only the thinking is shown and heard.

## Tech Stack

- **Runtime:** Browser (ES modules, no bundler)
- **LLM Inference:** OpenAI-compatible local providers (LM Studio, etc.) via `fetch()` + SSE
- **TTS:** Kokoro-82M-ONNX via Transformers.js (WebGPU/WebGL quantized)
- **Audio:** Web Audio API (AudioContext, GainNode, StereoPannerNode, AnalyserNode)
- **Storage:** localStorage with adapter seam (in-memory for tests)
- **Styling:** Inline CSS in `index.html` (single-file, no build step)

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
│  └── ui/history.js            Past sessions panel           │
├─────────────────────────────────────────────────────────────┤
│  Session Layer (coordinates state across models)            │
│  ├── session/orchestrator.js  Session lifecycle coordinator │
│  ├── session/channel-pipeline.js  Per-model full pipeline   │
│  ├── session/storage.js       SessionStore persistence      │
│  ├── session/local-storage-adapter.js  Production adapter   │
│  └── session/memory-storage-adapter.js  Test adapter        │
├─────────────────────────────────────────────────────────────┤
│  TTS Layer (text → audio synthesis + playback)              │
│  ├── tts/kokoro-backend.js    Transformers.js pipeline      │
│  ├── tts/tts-engine.js        Abstract interface            │
│  ├── tts/sentence-buffer.js   Token → sentence boundaries   │
│  └── tts/playback-queue.js    Sentence → audio queue        │
├─────────────────────────────────────────────────────────────┤
│  Audio Layer (Web Audio routing + visualization)            │
│  ├── audio/audio-graph.js     AudioContext + channels       │
│  └── audio/waveform.js        Canvas analyser viz           │
├─────────────────────────────────────────────────────────────┤
│  LLM Layer (streaming inference)                            │
│  ├── llm/llm-stream.js        streamReasoning() deep seam   │
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
  4. Fire all LLM streams concurrently (streamReasoning)
     • Tokens → ChannelPipeline.feedToken() → Column.appendToken()
     • Sentence boundaries → SentenceBuffer → TTSPlaybackQueue.enqueue()
     • TTS synthesis → AudioGraph channel.play() → waveform animates
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
new ChannelPipeline({ model, ttsConfig, column, ttsEngine, audioGraph, onIdle })
  .createChannel()                    // Creates audio channel + waveform
  .startStream(systemPrompt, question, signal?)  // → Promise (LLM → TTS)
  .drainText(text)                    // Replay stored reasoning
  .feedToken(token)                   // Manual token injection
  .softStop()                         // Abort stream + stop queue
  .flush()                            // Flush remaining buffer
  .pause() / .resume()                // Control TTS queue
  .isActive / .isCapped / .reasoningText  // Getters
```

### streamReasoning (`llm/llm-stream.js`)

Single-call LLM streaming. Hides fetch → SSE parse → callback pipeline.

```js
await streamReasoning(
  url,            // Full URL or base URL (handles /chat/completions)
  model,
  systemPrompt,
  question,
  {
    onReasoningToken: (token) => {},
    onContentStart: () => {},       // Content boundary reached
    onDone: () => {},
  },
  options = {},    // Extra body fields (e.g. { reasoning: { effort: "high" } })
  signal           // AbortSignal
);
```

### TTSPlaybackQueue (`tts/playback-queue.js`)

Explicit state machine: Idle → Synthesizing → Playing → Gapping → Idle, with Stopped and Paused states.

```
.enqueue(text)   // Add sentence to queue
.pause()         // Hold current position
.resume()        // Continue from pause
.stop()          // Soft stop: finish current, discard rest
.isActive        // Any pending or in-flight work?
.isPaused        // Currently paused?
```

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
Idle ──► Loading ──► Checking ──► Thinking ──► Speaking ──► Done
  │         │           │             │            │
  │         │           │             │            └─► (save to SessionStore)
  │         │           │             │
  │         │           │             └─► (all streams ended, TTS still playing)
  │         │           │
  │         │           └─► (health-check providers)
  │         │
  │         └─► (download TTS model)
  │
  └─── Stop ──► (soft stop: abort streams, finish current TTS, silence)
```

## File Inventory

| File | Responsibility | Depth |
|---|---|---|
| `index.js` | Bootstrap: wire UI → Orchestrator → AudioGraph | Shallow (wiring) |
| `config.js` | Static config: models, prompts, TTS params | Shallow (data) |
| `ui/prompt-selector.js` | Curated cards + free-text + Ask button | Deep |
| `ui/mode-toggle.js` | Chorus/Monologue toggle | Deep |
| `ui/column.js` | Per-model text stream + waveform lifecycle | Deep |
| `ui/history.js` | Session history panel | Deep |
| `session/orchestrator.js` | Session state coordination | Deep |
| `session/channel-pipeline.js` | Per-model pipeline (buffer→queue→channel) | Deep |
| `session/storage.js` | Session persistence with adapter seam | Deep |
| `session/local-storage-adapter.js` | localStorage wrapper | Shallow |
| `session/memory-storage-adapter.js` | In-memory adapter for tests | Shallow |
| `tts/kokoro-backend.js` | Transformers.js TTS pipeline + resampling | Deep |
| `tts/tts-engine.js` | Abstract TTS interface | Shallow (interface) |
| `tts/sentence-buffer.js` | Token accumulation + boundary detection | Deep |
| `tts/playback-queue.js` | TTS state machine (6 explicit states) | Deep |
| `audio/audio-graph.js` | Web Audio routing + ducking | Deep |
| `audio/waveform.js` | Canvas visualization from AnalyserNode | Deep |
| `llm/llm-stream.js` | Unified fetch + SSE parse + callbacks | Deep |
| `llm/health-check.js` | Provider reachability ping | Shallow |
| `getReasoningContent.js` | Standalone reasoning fetcher (legacy utility) | Shallow |
| `saveReasoning.js` | Standalone reasoning saver (legacy utility) | Shallow |
| `normalizeModelName.js` | Slugify model names for directories | Shallow |

## Legacy Scripts

`getReasoningContent.js` and `saveReasoning.js` are standalone Node.js utilities for fetching and saving reasoning content to disk. They are NOT part of the browser application flow. They reuse `llm/llm-stream.js` for streaming.

## Testing Approach

No test framework is installed. Smoke tests can be written with Node.js built-in `node:test` (Node 18+) since the codebase uses only standard APIs (`fetch`, streams, AbortController). Key testable modules:

- `llm/llm-stream.js` — Mock `fetch` with ReadableStream SSE responses
- `tts/playback-queue.js` — Mock TTS engine and channel
- `session/channel-pipeline.js` — Mock all dependencies
- `session/storage.js` — Inject MemoryStorageAdapter

## Known Extension Points

| Extension | How | Files |
|---|---|---|
| New LLM provider | Change `url` in `config.js` | `config.js` |
| New TTS backend | Extend `TTSEngine` | `tts/tts-engine.js` |
| New storage backend | Implement adapter interface | `session/storage.js` |
| IndexedDB storage | New adapter + inject | `session/storage.js` |
| New playback mode | Add state logic to Orchestrator | `session/orchestrator.js` |
| Config validation | Add schema check before bootstrap | `config.js`, `index.js` |
