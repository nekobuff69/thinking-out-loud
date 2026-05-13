# ADR-004: Streaming TTS Protocol with Incremental Text Feeding

## Status
## Status

Superseded by ADR-005 (Pocket TTS switch, May 2026).

Implementation completed across 7 slices (#41–#47), plus 4 defect-fix
slices (#49–#52), plus 2 architectural enhancements (#54–#55) and
2 test-coverage additions (#56–#57):
1. `server/tts-server-streaming.py` — TTSGen-based streaming server
   with cooperative round-robin stepping (#41)
2. Client streaming API: `KyutaiBackend.openStream()`, `AudioGraph.openStream()`,
   `ChannelPipeline` unsent-buffer accumulator (#42)
3. Orchestrator wiring: 3 KyutaiBackend instances, per-model backends,
   monologue mode (#43)
4. Polish: first-chunk 50ms timeout, Stop button (#44)
5. Debug events: server logs, client overlay (#46)
6. Replay verification: old path preserved unchanged (#47)
7. Defect fixes: softStop backend isolation, resume after flushAndClose,
   reconnect audio recovery, dropped-text observability (#49–#52)
8. Per-gen state isolation: each TTSGen owns its own KV cache bundles
   and Mimi codec instance; `_swap_caches_in()` before each step (#54)
9. Staggered warmup: cold TTSGens run in exclusive tight loop until
   first audio frame, then join round-robin (#55)
10. Regression tests: browser-side gapless scheduling and resume
    coverage (#56), server-side unit tests for cache isolation,
    padding handling, and warmup lifecycle (#57)

## Context

The current TTS protocol (`synthesize` with full text) causes stutter, glitch, and truncation during live reasoning streams. The root cause: every 100ms the client sends the full accumulated reasoning text to the server, stops the current audio, and restarts synthesis from scratch. This constant restart cycle prevents audio from progressing past the first few words, making speech unintelligible.

The Kyutai TTS model (DSM architecture) actually supports incremental text feeding via its `TTSGen` class, as demonstrated in Kyutai's `tts_mlx_streaming.py` reference implementation. However, the current server uses `tts_model.generate()` which requires all text upfront — a single-shot API that prevents true streaming.

## Decision

Replace the single-shot `synthesize` protocol with a streaming protocol that feeds text incrementally to a long-lived `TTSGen` instance on the server.

### Protocol: open_stream → text → close_stream

```
Client → Server: {"type":"open_stream","voice":"alba"}
Client → Server: {"type":"text","data":"I think"}
Client → Server: {"type":"text","data":" therefore"}
Client → Server: {"type":"close_stream"}
Server → Client: {"type":"pcm","data":[...]}     (streaming audio frames)
Server → Client: {"type":"done"}
Server → Client: {"type":"error","message":"..."}
```

**Key difference from old protocol:** `text` messages append entries to an ongoing generation rather than starting a new one each time. The old `synthesize` message is preserved exclusively for replay (where the full text is known upfront).

### Server: TTSGen-based cooperative round-robin stepping

**New file:** `server/tts-server-streaming.py` (rewrite, not modify). The old `server/tts-server.py` stays frozen for replay fallback.

Architecture decisions:
- **Cooperative round-robin** (not async tasks with lock): One asyncio loop iterates over all active TTSGens, giving each one MLX forward pass per round. Predictable fairness, simple to debug.
- **Staggered warmup**: New TTSGens require ~30 acoustic-delay steps before producing any audio. Cold gens run in an exclusive tight loop until they emit their first audio frame, then graduate to the shared round-robin cycle. This eliminates the 7+ second initial silence previously caused by interleaving warmup steps across all gens.
- **Per-gen state isolation**: Each TTSGen owns its own `transformer_cache` bundle, `depformer_cache` bundle, and `Mimi` codec instance — all independent of other gens. Before each `step()`, the gen swaps its cache bundles into the shared `tts_model.lm` via pointer reassignment (`_swap_caches_in()`). After the step, caches are updated in-place on the gen's own objects. Model weight matrices remain shared and read-only across all gens. This fixes multi-voice audio garbling caused by concurrent cache corruption.
- **Padding frame handling**: When no text entries have arrived yet, padding frames are injected to keep the model alive. These frames are always decoded through the per-gen `Mimi` instance (keeping codec state in sync), but the resulting PCM is discarded instead of sent to the client. Previously, skipping Mimi decode for padding frames caused codec state desynchronization and crackling audio.
- **One server process, N WebSocket connections**: One per model (3 connections total). Model weights are shared across TTSGen instances; KV caches and Mimi codec instances are per-instance.
- **Push PCM delivery**: Each `_step()` sends its audio frame immediately over WebSocket. No polling. TCP backpressure + browser AudioContext scheduling handle flow control naturally.
- **`stop` message**: Immediate kill — abort generation, discard pending entries, close cleanly. Required for the Stop button's "fresh slate" behavior.

### Client: three KyutaiBackend instances (one per model)

**Previous:** One shared `KyutaiBackend` with one WebSocket connection, shared by all 3 pipelines.
**New:** Three instances — each owns one WebSocket connection to the server. Each pipeline gets its own backend injected by the orchestrator.

This maps cleanly: 1 model = 1 WebSocket = 1 active stream = 1 TTSGen on the server. No multiplexing, no stream IDs.

**New API:**
```js
const backend = new KyutaiBackend({ wsUrl, modelName, eventBus });
await backend.load();                                        // opens WebSocket
const stream = backend.openStream(voice, { onAudioChunk, onDone, onError });
stream.sendText("I think");                                  // sends {"type":"text",...}
stream.close();                                              // sends {"type":"close_stream"}
backend.destroy();                                           // closes WebSocket
```

`KyutaiBackend` stays a dumb protocol pipe — no text processing, no word boundaries. The old `startStream(fullText, voice, ...)` method is preserved exclusively for replay.

### Client: incremental text accumulator in ChannelPipeline

**Removed from pipeline:** `#feedTts()` (debounce + flush logic), `#flushTts()` (full-text restart), timer management, `#firstBatchSent` flag.

**Added to pipeline:**
- `#unsentBuffer` — accumulates text not yet sent. Cleared on each `stream.sendText()` call.
- **Drain-on-send delta tracking:** on each flush, send buffer contents, clear buffer. No cursor arithmetic.
- **Word-boundary flush:** sends text when whitespace or sentence-ending punctuation is hit.
- **First-chunk 50ms timeout:** guarantees fast first audio even on long first words. Subsequent chunks flush on word boundaries only.
- Token cap, content boundary, LLM end all map to: send remaining delta + `stream.close()`.

### Client: new AudioGraph streaming mode

New method alongside old `playStream(streamFn)`:

```js
const handle = channel.openStream();     // new: async PCM delivery
handle.feed(pcm, sampleRate);            // called from WebSocket onmessage
handle.end();                            // signals no more frames coming
handle.stop();                           // immediate kill
```

Old `playStream(streamFn)` preserved unchanged for replay. Both modes share ducking and `activeCount` infrastructure.

### Monologue: client-side sequencing (no server changes)

Pipelines 1 and 2 are paused by the orchestrator — they accumulate text but never call `stream.sendText()`. When pipeline 0's TTS finishes, orchestrator resumes pipeline 1 which drains its accumulated text through normal `sendText()` calls. The server is unaware of monologue.

## Consequences

### Positive

- **Smooth, continuous audio:** No more stop-restart cycles. Audio progresses naturally through the full reasoning text.
- **Low first-audio latency:** First chunk sent on 50ms timeout or first word boundary. Sub-200ms typical.
- **Complete reasoning coverage:** All reasoning text reaches the TTS server, not just the first few words.
- **Cleaner client code:** Removes the debounce timer, full-text flush, and audio handle restart logic from ChannelPipeline.
- **Unaffected replay:** Old protocol and code path preserved untouched.
- **Better debuggability:** Per-model WebSocket connections mean per-model connection state, independent reconnection, and labeled server logs.
- **Clean audio isolation:** Per-gen state isolation (each TTSGen owns its own KV cache bundles and Mimi codec instance) prevents cache corruption between sequentially active TTSGen instances. Only one TTSGen is active at a time (sequential playback), ensuring clean, stutter-free audio.
- **Faster first-audio startup:** Staggered warmup runs new TTSGens exclusively until their first audio frame, cutting initial silence from ~7s to ~2.5s per voice.
- **Crackle-free padding:** Padding frames (injected when text hasn't arrived yet) always decode through the per-gen Mimi instance, keeping codec state synchronized — eliminating the cracking/popping artifact that occurred when codec state was skipped.

### Negative / Trade-offs

- **New server file:** `tts-server-streaming.py` must be maintained alongside `tts-server.py` (which is frozen for replay fallback). Two server files until old protocol is fully retired.
- **Three WebSocket connections instead of one:** Marginal overhead (all to localhost).
- **Protocol break:** Old clients cannot use the new server and vice versa. But since this is a single-user app, no migration period needed.

## References

- Kyutai TTS blog post: <https://kyutai.org/blog/2025-07-03-kyutai-tts-1-6b#delayed-streams-modeling>
- Streaming MLX implementation: <https://github.com/kyutai-labs/delayed-streams-modeling/blob/main/scripts/tts_mlx_streaming.py>
- DSM research paper: <https://arxiv.org/html/2509.08753v2>
- PRD: <https://github.com/nekobuff69/thinking-out-loud/issues/40>
- Bug: <https://github.com/nekobuff69/thinking-out-loud/issues/53> — Garbled multi-voice audio (fixed by per-gen state isolation)

## Related

- `docs/adr/003-kyutai-tts-streaming-refactor.md` — Original Kyutai adoption (single-shot protocol, now superseded for live path)
- `CONTEXT.md` — Updated TTS layer and data flow
- `UBIQUITOUS_LANGUAGE.md` — New streaming terms defined
