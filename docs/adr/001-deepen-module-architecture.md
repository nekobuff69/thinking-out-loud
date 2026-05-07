# ADR-001: Deepen Module Architecture — Extract ChannelPipeline, Merge LLM Stream, Add Storage Seam

## Status

Accepted — implemented in issues #9, #15, #16, #17, #18. Post-implementation testing added in #22–#27 (May 2026).

## Context

Post-implementation review of the "Thinking Out Loud" codebase identified five shallow modules and one god-module:

1. **Orchestrator managed anonymous 8-key objects** representing per-Model pipelines instead of a named module with a clean interface.
2. **LLM fetch and stream parse** were separate functions (`streamCompletion` + `parseStream`) that every caller had to wire together manually.
3. **SessionStore hard-coded `localStorage`** with no adapter seam, making it untestable without a browser.
4. **Column UI leaked its internal canvas node** to callers via the `waveform` property.
5. **TTSPlaybackQueue managed 4 interleaved boolean flags** (`#playing`, `#stopped`, `#softStopping`, `#paused`) creating 16 implicit states with unchecked transitions.

## Decision

Deepen five modules and simplify one coordinator. Each module now hides significant behavior behind a small interface. External application behavior does not change — this is purely internal restructuring.

### 1. Extract ChannelPipeline from Orchestrator

**Before:** Orchestrator built anonymous objects with 8 keys (`model`, `column`, `channel`, `streamActive`, `ttsActive`, `contentHit`, `reasoningText`, `queue`, `buffer`).

**After:** `ChannelPipeline` class encapsulates the full per-Model pipeline:
- `createChannel()` — creates AudioGraph channel + attaches waveform
- `startStream()` — calls `streamReasoning`, feeds tokens to buffer/column
- `drainText()` — replay stored reasoning with visual chunking delay
- `softStop()` / `flush()` / `pause()` / `resume()` — lifecycle controls
- Getters: `isActive`, `isCapped`, `reasoningText`, `modelName`

**Rationale:** Callers no longer need to know about SentenceBuffers, TTSPlaybackQueues, or token caps. The pipeline's lifecycle is encapsulated. Passes the deletion test — deleting ChannelPipeline would force its complexity into N callers.

### 2. Merge LLM Stream into a single deep module

**Before:** `streamCompletion()` returned a `ReadableStream`, then `parseStream()` consumed it with callbacks. Callers had to import both and wire them.

**After:** `streamReasoning()` is a single async function that internally fetches, parses SSE, and fires callbacks. The `ReadableStream` is never exposed.

**Interface:**
```js
await streamReasoning(url, model, systemPrompt, question, callbacks, options?, signal?);
```

**Rationale:** Callers don't need to know about `fetch` response objects, `ReadableStream` readers, SSE parsing, or buffering. One call replaces two imports + wiring.

### 3. Add storage adapter seam

**Before:** `SessionStore` called `localStorage.getItem()` / `setItem()` directly.

**After:** Constructor accepts an optional `storageAdapter` with `{ getItem, setItem, removeItem }`. Default adapter wraps `localStorage`. `MemoryStorageAdapter` provided for tests.

**Rationale:** Two adapters make the seam real (not hypothetical). Tests run without a browser. IndexedDB adapter can be added later without touching SessionStore logic.

### 4. Internalize waveform lifecycle in Column

**Before:** `createColumn()` returned `{ ..., waveform }` — a raw canvas DOM node. Callers (index.js via `onChannelCreated`) had to import `createWaveform` and wire it.

**After:** `createColumn()` returns `{ ..., attachWaveform(analyserNode, color), stopWaveform() }`. The Column internally imports `createWaveform`, manages resize observers, animation frames, and cleanup. `onChannelCreated` callback removed entirely.

**Rationale:** No module outside Column needs to know about canvas DOM nodes. The Column's DOM structure is private.

### 5. Formalize TTSPlaybackQueue as explicit state machine

**Before:** 4 boolean flags → 16 implicit states. Transitions were unchecked.

**After:** 6 named states with explicit transitions:
```
Idle ──enqueue()──► Synthesizing ──synth done──► Playing ──playback done──► Gapping ──timeout──► Synthesizing
  │                                                                                          │
  └──stop()──► Stopped      pause()──► Paused ──resume()──► previous state
```

**Rationale:** Every invalid transition is now a no-op or immediately visible. State-space complexity reduced from 16 implicit states to 6 explicit states with checked transitions.

### 6. Simplify Orchestrator

**Before:** Orchestrator managed pipeline construction, stream wiring, replay logic, waveform attachment, abort controllers, and session state.

**After:** Orchestrator is a thin Session state coordinator:
- Manages session lifecycle: Idle → Loading → Thinking → Speaking → Done
- Creates ChannelPipelines (delegates pipeline logic)
- Starts all streams concurrently, checks if all done
- Advances monologue when previous pipeline reports idle
- Saves completed sessions

**Rationale:** Per-Model pipeline logic lives in ChannelPipeline. Session transitions are the Orchestrator's only responsibility. This passes the deletion test — the Orchestrator is a real coordinator; deleting it would concentrate complexity.

## Consequences

### Positive

- **Testability:** ChannelPipeline, TTSPlaybackQueue, and SessionStore can be unit-tested with mocked dependencies. LLM Stream can be tested with mock `fetch` responses.
- **Change locality:** Modifications to sentence boundary logic, TTS queueing, or audio routing affect only one module.
- **AI-navigability:** Each module's interface is small enough to understand without reading its implementation.
- **No behavioral regression:** The application's external behavior (UI, audio, session flow) is identical.

### Negative / Trade-offs

- **More files:** 13 source files became 15 (added `channel-pipeline.js`, `local-storage-adapter.js`, `memory-storage-adapter.js`; removed `lm-studio-client.js`, `stream-parser.js`). Net +2 files.
- **Slightly more indirection:** `Orchestrator` → `ChannelPipeline` → `TTSPlaybackQueue` adds one layer versus the previous flat object.
- **Tests added post-implementation:** 15 tests across 5 suites using Node.js built-in `node:test`. Covers SentenceBuffer token cap, health-check URL construction, LLM stream endpoint construction, orchestrator stop→Idle transition, and ChannelPipeline empty-stream detection.

## Related Issues

**Architecture (resolved):**
- #9 — Parent architecture deepening PRD
- #15 — Restore LLM stream configurability and fix URL handling
- #16 — Clean up ChannelPipeline lifecycle + Orchestrator error swallowing
- #17 — Fix minor nits (gitignore newline + waveform controller contract)
- #18 — Remove dead Stopped-state branches from TTSPlaybackQueue

**Post-ADR fixes + tests (resolved):**
- #22 — Orchestrator stop→Idle, empty-stream detection
- #23 — SentenceBuffer total-token cap
- #24 — Docs accuracy (CONTEXT.md, package.json)
- #25 — Loading UX, keyboard a11y, TTS error catch
- #26 — URL construction hardening
- #27 — CORS docs + .env cleanup
