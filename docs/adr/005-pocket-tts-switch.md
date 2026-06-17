# ADR-005: Switch from Kyutai DSM to Pocket TTS

## Status
## Status

Accepted — implemented, May 2026. DSM code removed, Pocket TTS server + client deployed.

## Context

The app requires **voice cloning** — the ability to create custom speaker voices from user-provided WAV audio samples. Investigation revealed:

1. **DSM voice cloning requires a gated model.** The DSM `speaker_wavs` embeddings are created by a special `_mimi_voice.safetensors` model that Kyutai has kept private (locked on HuggingFace, returns 401/404). Source: [moshi#404](https://github.com/kyutai-labs/moshi/issues/404).

2. **Raw Mimi encoder output is incompatible.** The standard Mimi encoder produces latents with correct shape `(1, 512, N)` but wrong value distribution (std≈0.06 vs std≈0.72 for working embeddings). Using raw encoder output as voice embeddings produces garbled/noise audio.

3. **Pocket TTS natively supports voice cloning.** `get_state_for_audio_prompt("./my_voice.wav")` encodes any WAV/MP3 through Mimi → FlowLM speaker projection → ready for generation. No gated model required.

4. **Pocket TTS has streaming audio output.** `generate_audio_stream()` yields audio chunks as they're decoded, with ~200ms first-audio latency. It splits long text into sentences internally.

5. **Pocket TTS is smaller and faster.** 100M params (vs 1.6B), CPU-only (no GPU required), 6× real-time on M4, 200-400 MB RAM (vs 3-6 GB).

## Decision

**Switch to Pocket TTS** as the TTS backend, deprecating the DSM-based server and client integration.

## Rationale

Voice cloning is a hard requirement. DSM cannot satisfy it without access to a gated model Kyutai has chosen not to release. There is no viable workaround — the raw Mimi encoder output is distributionally incompatible with the DSM conditioning path.

Pocket TTS satisfies all key requirements:
- **Voice cloning:** native, from any WAV file, no external dependencies
- **Audio quality:** ELO 2016 vs DSM's 1959 (slightly better)
- **Streaming:** audio chunks yielded as decoded (~200ms first audio)
- **Resource footprint:** 10× smaller, CPU-only, no GPU needed on Apple Silicon

The main trade-off is losing DSM's **token-level incremental text feeding**. Pocket TTS requires complete sentences before generating audio. However:
- The app's `text-chunker.js` splits text on configurable punctuation (`.!?;,`), max words, and silence timeout — producing natural sentence/clause boundaries
- The clause-level granularity is sufficient for the app's use case (LLMs output paragraph-level reasoning)
- The 200ms first-audio latency per chunk is competitive with DSM's ~2.5s warmup
## Consequences

### What changes
- **New TTS server:** Replace `server/tts-server-streaming.py` (WebSocket, MLX, 700 lines) with a Pocket TTS-based server (HTTP + streaming audio, ~200 lines)
- **Client rewrite:** Replace `tts/kyutai-backend.js` (WebSocket streaming) with Pocket TTS HTTP client
- **Pipeline adaptation:** Update `session/channel-pipeline.js` for sentence-level HTTP requests, reuse `text-chunker.js`
- **Config update:** `config.js` voice values become WAV paths or pre-exported `.safetensors` voice states

### What stays
- `tts/text-chunker.js` — reused for sentence splitting
- `ui/` components — DebugOverlay, Column unchanged
- `session/orchestrator.js` — sequential TTS playback per model, same semantics
- `session/event-bus.js` — same event model

### What is deprecated
- `server/tts-server-streaming.py` — DSM WebSocket server
- `server/tts-server.py` — legacy single-shot server
- `tts/kyutai-backend.js` — DSM WebSocket client
- `server/requirements.txt` — replace `moshi-mlx` with `pocket-tts`

### What is gained
- Voice cloning from any WAV file
- 200ms first-audio latency (vs 2.5s warmup)
- CPU-only runtime (no GPU contention)
- 10× less memory (200-400 MB vs 3-6 GB)
- Simpler server (200 lines vs 700)
- No HuggingFace authentication issues (Pocket TTS weights are public)

### Risks
- **Sentence-level latency:** If a sentence is very long, audio won't start until the full sentence is tokenized. Mitigation: text-chunker splits on commas and other mid-sentence punctuation, configurable via `chunkerPunctuation` in `config.js`.
- **PyTorch dependency:** Pocket TTS requires PyTorch (vs MLX for DSM). Both are available on the user's machine.
- **Speaker similarity:** Pocket TTS ELO 1898 vs DSM 2037. Pocket TTS may be slightly less faithful to the original voice timbre.
- **Backward compatibility:** This is a breaking change. The new protocol is HTTP-based, not WebSocket. All TTS-related code must be rewritten together.

## Alternatives considered

### Bridge DSM + Pocket TTS voice embeddings
Use Pocket TTS to create voice embeddings, convert to DSM format. **Rejected** — the two formats are fundamentally incompatible (KV cache state vs Mimi encoder latent). DSM's voice conditioning path depends on a specific distribution that only the gated `_mimi_voice` model can produce.

### Request Kyutai access for gated model
Open an issue asking Kyutai to release the voice cloning weights or generate embeddings one-off. **Rejected as primary path** — uncertain timeline, no guarantee of success. May pursue in parallel as a fallback.

### Keep DSM without voice cloning
Use only pre-built voices from `kyutai/tts-voices`. **Rejected** — voice cloning is a hard requirement for the user.

## References

- [moshi#404](https://github.com/kyutai-labs/moshi/issues/404) — GitHub issue confirming gated voice cloning model
- [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) — source repository
- [Pocket TTS paper](https://arxiv.org/abs/2509.06926) — CALM architecture, Table 12 DSM comparison
- `docs/tts-technology-evaluation.md` — full comparison and analysis
- `UBIQUITOUS_LANGUAGE.md` — updated domain terminology
- ADR-003 — Kokoro → DSM transition (superseded by this ADR)
- ADR-004 — Streaming TTS protocol (superseded by this ADR)
