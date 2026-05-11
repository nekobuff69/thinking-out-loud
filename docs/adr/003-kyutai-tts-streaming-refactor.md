# ADR-003: Replace Kokoro with Kyutai TTS via Local MLX Server

## Status

Accepted — implemented, May 2026.

Implementation completed across 5 slices (#35–#39):
1. `server/tts-server.py` — Python+MLX WebSocket server with Mimi codec
2. `tts/kyutai-backend.js` — WebSocket client with auto-reconnect and event emission
3. Pipeline integration — direct token streaming to TTS (no sentence buffering)
4. Resilience (reconnect with exponential backoff), observability (time-to-first-chunk), TextChunker fallback
5. Cleanup: removed `kokoro-backend.js`, `sentence-buffer.js`, `playback-queue.js`, and `kokoro-js` / `@huggingface/transformers` dependencies

## Context

Live demos revealed unacceptable latency and silence gaps in TTS playback. The current architecture has three root causes:

1. **Sentence bundling:** `SentenceBuffer` waits for 2 complete sentences before flushing to TTS. On reasoning text with long compound sentences, this can delay first audio by 10–30+ seconds.
2. **Batch synthesis:** `KokoroBackend.synthesize()` returns a complete `AudioBuffer`. There is no incremental audio — the full sentence must be synthesized before any sound plays.
3. **First-sentence cold start:** `TTSPlaybackQueue` can only pre-synthesize sentence N+1 *during* sentence N. The very first sentence always pays full synthesis cost with no overlap.

Kokoro (82M params, ONNX in browser) is fundamentally a batch TTS model. Its `kokoro-js` wrapper provides `TextSplitterStream` but still emits complete `AudioBuffer` per sentence. There is no true token-level streaming.

After research, [Kyutai's Delayed Streams Modeling (DSM) TTS](https://github.com/kyutai-labs/delayed-streams-modeling) offers a fundamentally different architecture: a single auto-regressive LM predicts Mimi audio codec tokens directly from text tokens, emitting audio frames with a fixed model delay (~80 ms per frame) without waiting for sentence boundaries. Kyutai provides an MLX implementation optimized for Apple Silicon.

## Decision

Replace Kokoro entirely with Kyutai TTS served by a local Python+MLX server that the browser connects to via WebSocket.

### 1. Server stack: Python + MLX (not Rust)

Use `moshi-mlx` with a thin Python wrapper server (~50 lines). MLX is Apple's ML framework and uses the Neural Engine / Metal GPU on Apple Silicon. Quantization (`--quantize 8` or `4`) provides a quality/speed trade-off if real-time isn't met initially.

**Not chosen:** The Rust `moshi-server` is the official production stack, but installation on macOS is problematic (the FAQ documents CMake and gcc build issues with the sentencepiece dependency). A Python+MLX wrapper is lower friction for a single-user Mac setup.

### 2. Protocol: WebSocket (not SSE or HTTP chunked)

The browser opens a persistent WebSocket connection to `ws://localhost:<port>`. Messages:

- **Client → Server:** `{ type: "synthesize", text: "...", voice: "alba" }`
- **Server → Client:** `{ type: "pcm", data: <Float32Array> }` (streaming frames)
- **Server → Client:** `{ type: "done" }` (end of generation)
- **Server → Client:** `{ type: "error", message: "..." }`

**Not chosen:** SSE is used for LLM streaming but requires base64-encoding binary audio, adding latency and bandwidth overhead. HTTP chunked transfer works but is clunkier for bidirectional streaming.

### 3. Replace `TTSEngine` interface with streaming contract

The old pull-based interface is removed:
```js
// REMOVED
synthesize(text, voice) → Promise<AudioBuffer>
```

The new push-based streaming interface:
```js
load() → Promise<void>
startStream(text, voice, onAudioChunk) → void
stop() → void
destroy() → void
```

`onAudioChunk(Float32Array pcm, sampleRate)` fires as soon as each audio frame is decoded. The audio layer appends to a ring buffer and plays continuously.

Since Kokoro is dropped, there is no need for a dual-path interface. One streaming contract serves the architecture.

### 4. Eliminate `SentenceBuffer` and `TTSPlaybackQueue` sentence bundling

**Before:** `SentenceBuffer` accumulates tokens → detects sentence boundaries → bundles 2 sentences → `TTSPlaybackQueue` pre-synthesizes next sentence → plays complete `AudioBuffer` → 50 ms gap → repeat.

**After:** Text tokens stream directly from the LLM response to the TTS server via WebSocket. No sentence bundling, no boundary detection, no pre-synthesis queue. The audio layer plays PCM chunks as they arrive.

If raw word-level streaming produces choppy prosody, a lightweight `TextChunker` can be inserted client-side (flush on punctuation, 150ms timeout, or 8-word max) **without any server or audio pipeline changes**. This is a pure client-side swap.

### 5. Voice configuration: Kyutai pre-computed embeddings

Kokoro's preset voice IDs (`af_bella`, `bm_lewis`, etc.) are replaced with Kyutai's pre-computed voice embedding names from `kyutai/tts-voices`. The server downloads and caches embeddings on first run.

**Future path:** Switch to local `.wav` reference files by changing `config.js` voice values to file paths and updating the server to compute embeddings from those files.

## Architecture changes

### Files removed
- `tts/kokoro-backend.js` — Kokoro dependency removed entirely
- `tts/sentence-buffer.js` — sentence bundling no longer needed
- `tts/playback-queue.js` — pre-synthesis queue no longer needed

### Files added / rewritten
- `tts/kyutai-backend.js` — WebSocket client implementing new `TTSEngine`
- `tts/tts-engine.js` — updated streaming interface
- `tts/text-chunker.js` — lightweight optional word accumulator (fallback if needed)
- `server/tts-server.py` — Python+MLX wrapper server
- `server/requirements.txt` — `moshi-mlx`, `websockets`, etc.

### Files modified
- `session/channel-pipeline.js` — feeds tokens directly to TTS backend instead of buffering sentences
- `audio/audio-graph.js` — `playStream()` method for appending PCM chunks to a ring buffer
- `config.js` — voice identifiers updated to Kyutai embedding names
- `package.json` — `kokoro-js` and `@huggingface/transformers` removed
- `CONTEXT.md` — TTS layer description updated

## Consequences

### Positive

- **Dramatically lower first-audio latency:** From "time to synthesize 2 sentences" (often 10–30s) to "time for first few words + model delay" (sub-second).
- **Gap-free playback:** Continuous PCM stream eliminates the 50 ms inter-sentence gaps.
- **Apple Silicon optimized:** MLX uses Metal GPU / Neural Engine on Mac.
- **Simpler pipeline:** Removes SentenceBuffer boundary detection, PlaybackQueue state machine, and pre-synthesis logic.
- **Architecturally consistent:** The app already requires a local LLM server (LM Studio at `localhost:1234`). A local TTS server on another port fits the same operational model.

### Negative / Trade-offs

- **New operational dependency:** Users must run `python server/tts-server.py` alongside LM Studio. The app will not work without it.
- **No browser fallback:** If the TTS server is not running, there is no TTS. Kokoro's in-browser ONNX execution is gone.
- **Larger model:** Kyutai TTS is 0.75B–1.6B parameters vs Kokoro's 82M. First download is several GB.
- **Python dependency:** Requires Python 3.12+, MLX, and `moshi-mlx`. The Rust server would have been a single binary.
- **No offline voice selection at runtime:** Voices are embeddings, not preset IDs. Adding new voices requires reference audio files and server-side embedding computation.

### Not taken: alternative options

- **Keep Kokoro and add word-level streaming** — Kokoro's `TextSplitterStream` still emits complete sentences; it cannot do true token-level streaming.
- **Use Rust server instead of Python+MLX** — Would be a single binary but macOS installation is problematic (sentencepiece build issues documented in FAQ).
- **Keep browser-only and wait for WebGPU TTS** — No browser port of Kyutai exists, and 0.75B+ param models are far beyond current browser ML capabilities.

## Migration plan

1. Create `server/tts-server.py` with WebSocket endpoint and MLX inference loop
2. Rewrite `tts/tts-engine.js` with streaming interface
3. Implement `tts/kyutai-backend.js` as WebSocket client
4. Update `audio/audio-graph.js` with streaming PCM playback
5. Rewrite `session/channel-pipeline.js` to pipe tokens directly to TTS
6. Update `config.js` voice identifiers
7. Remove `kokoro-js` and `@huggingface/transformers` from `package.json`
8. Update `CONTEXT.md` and create this ADR
9. Test: run server, run app, verify first-audio latency < 2s

## Related

- `CONTEXT.md` — TTS layer description updated
- `docs/adr/002-kokoro-js-tts-backend.md` — Previous TTS backend decision (superseded)
- <https://github.com/kyutai-labs/delayed-streams-modeling> — Kyutai DSM repository
- <https://github.com/kyutai-labs/moshi-swift> — Swift/MLX implementation reference
