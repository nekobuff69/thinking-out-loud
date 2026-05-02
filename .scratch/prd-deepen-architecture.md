## Problem Statement

The codebase works, but several modules are shallow — their interfaces expose nearly as much complexity as their implementations. The Orchestrator manages 8-key anonymous objects representing per-Model pipelines instead of having a named module with a clean interface. The LLM fetch and stream parse steps must always be called together but have no shared seam. The Session Store hard-codes localStorage with no adapter seam, making it untestable without a browser. The Column UI leaks its internal canvas node to callers. The TTSPlaybackQueue manages 4 interleaved boolean flags creating 16 possible states with implicit transition rules. These shallownesses reduce leverage (callers must know too much) and locality (concerns scatter across modules).

## Solution

Deepen five modules and simplify one coordinator so that each module hides significant behaviour behind a small interface. The external behaviour of the application does not change — this is purely an internal restructuring that improves testability, AI-navigability, and change locality.

## User Stories

1. As a developer, I want the per-Model pipeline (buffer → queue → column → channel) to be a named module with a small interface, so that I can reason about one Model's full pipeline without tracing anonymous object keys across the Orchestrator.

2. As a developer, I want to create a Channel Pipeline by calling a constructor instead of building an 8-key object, so that the pipeline's lifecycle is encapsulated.

3. As a developer, I want to feed reasoning tokens into a Channel Pipeline with a single method, so that the Orchestrator doesn't need to know about SentenceBuffers or token caps.

4. As a developer, I want to replay a past Session by calling `drainText(text)` on a Channel Pipeline, so that replay logic doesn't duplicate the streaming path.

5. As a developer, I want the LLM streaming module to accept a single `streamReasoning()` call instead of manually wiring `streamCompletion()` → `parseStream()`, so that callers don't need to know about ReadableStream intermediaries.

6. As a developer, I want the LLM streaming module to have a provider-neutral name, so that adding non-LM-Studio providers doesn't require a misleading module name.

7. As a developer, I want the legacy `getReasoningContent.js` script to call the deepened LLM Stream module, so that the old fetch+parse wiring doesn't remain duplicated.

8. As a developer, I want the Session Store to accept a storage adapter at construction time, so that tests can inject an in-memory adapter without touching localStorage.

9. As a developer, I want a default localStorage adapter that preserves current behaviour, so that the production app works identically after this change.

10. As a developer, I want the Column UI module to manage its own waveform lifecycle internally, so that no other module needs to know about canvas DOM nodes.

11. As a developer, I want to call `column.attachWaveform(analyserNode, color)` instead of receiving a raw canvas and wiring it externally, so that the Column's interface is smaller and its DOM structure is private.

12. As a developer, I want the Orchestrator to drop the `onChannelCreated` callback, so that waveform wiring doesn't scatter across the Orchestrator, AudioGraph, and index.js.

13. As a developer, I want the TTSPlaybackQueue to use an explicit state machine (Idle → Synthesizing → Playing → Gapping → Idle, with Stopped and Paused states), so that every transition is checked rather than relying on 4 interleaved boolean flags.

14. As a developer, I want the TTSPlaybackQueue's external interface (`enqueue`, `pause`, `resume`, `stop`) to stay the same, so that callers don't change — only the invariants beneath the interface improve.

15. As a developer, I want the Orchestrator to be a thin Session state coordinator (Idle → Loading → Thinking → Speaking → Done), so that the per-Model pipeline logic lives in Channel Pipeline and the state transitions are the Orchestrator's only responsibility.

16. As a developer reviewing this codebase in the future, I want each module's interface to be small enough to understand without reading its implementation, so that the codebase is AI-navigable and maintainable.

## Implementation Decisions

### Channel Pipeline (new deep module, extracted from Orchestrator)

- Extracted from the anonymous objects currently stored in `Orchestrator.#activeSessions`.
- Each Channel Pipeline owns: one SentenceBuffer, one TTSPlaybackQueue, one Column reference, one Channel reference from AudioGraph, and accumulated reasoning text.
- Interface: `feedToken(token)` (forwards to buffer, appends to column), `drainText(text)` (for replay — feeds text in chunks with visual delay, flushes to TTS), `softStop()` (forwards to queue), `flush()` (forwards to buffer), getters `isActive`, `isCapped`, `reasoningText`.
- Channel Pipeline subscribes to its own queue's `onIdle` callback and its own buffer's `onSentence` callback internally. The Orchestrator no longer wires these per-session.
- The Orchestrator still manages monologue advancement. When a Channel Pipeline reports idle, the Orchestrator checks whether to advance the next pipeline. This is the Orchestrator's coordination responsibility, not the pipeline's.

### LLM Stream (deepened from lm-studio-client.js + stream-parser.js)

- Merge `streamCompletion()` and `parseStream()` into a single module with a deep interface.
- Interface: `streamReasoning(baseUrl, model, systemPrompt, question, { onReasoningToken, onContentStart, onDone }, signal?)` — returns a Promise that resolves when the stream ends.
- The implementation internally calls fetch, obtains the ReadableStream, and parses SSE events. The ReadableStream is never exposed to callers.
- Module is renamed to something provider-neutral (e.g., `llm-stream.js`). The `lm-studio-client.js` and `stream-parser.js` files are removed.
- The legacy `getReasoningContent.js` script calls this module's interface instead of wiring fetch + parse itself.
- Retry logic (single retry on network failure) stays inside the module.

### Session Store with storage adapter seam (modified)

- `SessionStore` constructor gains an optional `storageAdapter` parameter.
- Default adapter wraps `localStorage` with `getItem(key)` and `setItem(key, value)` methods.
- Tests can inject an in-memory Map adapter.
- The adapter seam is at construction time, not at every method call — leverage comes from configuring once.
- Eviction and quota-exceeded logic remain inside SessionStore, behind its interface.
- Two adapters (localStorage for production, in-memory Map for tests) make this a real seam.

### Column UI (deepened)

- Remove `waveform` (raw canvas DOM node) from the `createColumn()` return interface.
- Add `attachWaveform(analyserNode, color)` method to the returned object. This method creates the waveform internally and manages its lifecycle (resize observer, animation frame, cleanup).
- The Column module internally imports `createWaveform` from `audio/waveform.js`.
- `stopWaveform()` is called when the column is cleared.
- The Orchestrator's `onChannelCreated` callback is removed. Instead, the Orchestrator gives each Channel Pipeline its Column, and the Pipeline calls `column.attachWaveform(channel.analyser, model.color)` when the channel is created.

### TTSPlaybackQueue (deepened)

- Replace the 4 boolean flags (`#playing`, `#stopped`, `#softStopping`, `#paused`) with an explicit state machine.
- States: `Idle`, `Synthesizing`, `Playing`, `Gapping` (the 200ms inter-sentence pause), `Stopped`, `Paused`.
- Transitions:
  - `Idle` + `enqueue()` → `Synthesizing`
  - `Synthesizing` + synthesis complete → `Playing`
  - `Playing` + playback ended → `Gapping` (or `Idle` if queue empty and not soft-stopping)
  - `Gapping` + timeout → `Synthesizing` (next sentence)
  - Any active state + `stop()` → `Stopped` (with soft-stop semantics: if currently playing, let it finish then transition)
  - `Synthesizing`/`Playing`/`Gapping` + `pause()` → `Paused`
  - `Paused` + `resume()` → return to previous state
- External interface unchanged: `enqueue(text)`, `pause()`, `resume()`, `stop()`, `isActive`, `isPaused`.
- State transitions throw or no-op on invalid transitions, making bugs immediately visible.

### Orchestrator (simplified)

- `start()` and `replay()` both create Channel Pipelines instead of raw objects.
- The Orchestrator manages Session state transitions (Idle → Loading → Thinking → Speaking → Done) and coordinates Channel Pipelines (start all, check if all done, advance monologue).
- `onChannelCreated` callback is removed. Channel Pipeline handles its own waveform attachment.
- `#activeSessions` Map values change from anonymous objects to Channel Pipeline instances.
- `start()`: creates pipelines, calls `pipeline.feedToken(token)` in the stream callback.
- `replay()`: creates pipelines, calls `pipeline.drainText(text)` for each stored reasoning text.

## Testing Decisions

- **What makes a good test:** Tests verify observable behaviour through the module's external interface — inputs and outputs, state transitions, callback invocations. Tests do not assert on internal implementation details, private field values, or DOM node structure unless testing the UI module's own interface.
- **Modules to test (when tests are introduced):**
  - **Channel Pipeline:** Feed tokens, verify text accumulates, verify TTS sentences fire, verify cap behaviour, verify drain for replay. Mock the TTS engine and audio channel.
  - **LLM Stream:** Provide mock SSE responses, verify `onReasoningToken`, `onContentStart`, `onDone` callbacks fire correctly. Verify abort signal works. Verify single retry on network failure.
  - **Session Store:** Round-trip save/load, eviction when over max, quota-exceeded fallback. Test with in-memory adapter (no localStorage dependency).
  - **TTSPlaybackQueue:** Verify state transitions are valid, invalid transitions throw, enqueue/pause/resume/stop produce correct observable behaviour. Mock TTS engine and audio channel.
  - **SentenceBuffer:** Already deep and testable — verify sentence boundary detection, timeout flush, token cap, abbreviation handling.
- **Prior art:** The existing codebase has no tests. This PRD establishes the testing approach as interface-level black-box tests using mocked dependencies.

## Out of Scope

- Writing tests for this PRD — a separate issue will track test implementation.
- Changing the application's external behaviour (UI, audio, session flow all remain identical).
- Adding IndexedDB storage — the adapter seam enables this later, but only the localStorage and in-memory adapters are built now.
- Adding new LLM providers beyond OpenAI-compatible — the LLM Stream module rename enables this later, but no new provider adapters are built now.
- Refactoring config.js or adding a config validation layer.
- Refactoring the UI modules (prompt-selector, mode-toggle, history) beyond the Column waveform change.
- Removing `getReasoningContent.js` or `saveReasoning.js` — the legacy script is updated to use the deepened LLM Stream module but remains as a standalone utility.

## Further Notes

- This work is informed by the architecture review that identified 5 shallow modules and 1 god-module. The ubiquitous language in `UBIQUITOUS_LANGUAGE.md` is used throughout: Session, Question, Model, Channel, Reasoning, Sentence Buffer, TTSPlaybackQueue, Content boundary, etc.
- The deletion test was applied to each candidate: deleting the Orchestrator would concentrate complexity (it's a real coordinator), deleting the anonymous per-Model objects would not (they're shallow pass-throughs). The Channel Pipeline extraction passes the deletion test — delete it and the complexity moves into N callers.
- The TTSPlaybackQueue state machine has 6 states vs the current 4 flags creating 16 implicit states. This is a reduction in state-space complexity even though it's an increase in named states — every invalid transition is now caught.
- The storage adapter seam follows the principle: one adapter means a hypothetical seam, two adapters means a real one. The in-memory test adapter is the second adapter that makes the seam real.