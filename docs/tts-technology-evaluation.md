> **Update May 2026:** Switch implemented. See ADR-005 and issues #62–#67.

# TTS Technology Evaluation: Pocket TTS vs DSM

2026-05-12 — Research note. Compare Kyutai Pocket TTS to current DSM TTS stack.
Evaluate voice cloning, quality, performance, and integration feasibility.

## Key Question: Can we use local WAV files as voice samples?

**Pocket TTS: YES, natively.** `get_state_for_audio_prompt("./my_voice.wav")`
encodes any WAV/MP3 through Mimi → FlowLM speaker projection → ready for generation.
Export as `.safetensors` for instant reload.

**Current DSM (moshi-mlx): NO.** Voice embeddings require a gated/private model
(`_mimi_voice.safetensors`) that Kyutai has not released publicly. The standard Mimi
encoder produces latents with the correct shape but **wrong value distribution**
(std≈0.06 vs std≈0.72 for working voices). Attempting to use raw Mimi encoder
output as a voice embedding results in garbled/noise audio.
Source: [moshi#404](https://github.com/kyutai-labs/moshi/issues/404).
Workaround: request Kyutai to generate embeddings one-off, or switch to Pocket TTS.
## Architecture Comparison

| Criterion | DSM (current) | Pocket TTS |
|---|---|---|
| **Parameters** | 0.75B–1.6B | 100M |
| **Model type** | Auto-regressive LM (causal) | Flow matching + LSD |
| **Codec** | Mimi RVQ (discrete, 16 tokens/frame) | Mimi VAE (continuous latents) |
| **Frame rate** | 12.5 Hz | 12.5 Hz |
| **Sample rate** | 24 kHz | 24 kHz |

## Quality (source: Pocket TTS paper Table 12, Librispeech test-clean)

| Metric | DSM 750M | Pocket TTS 100M |
|---|---|---|
| **WER ↓** | 1.84 | 1.84 (tied) |
| **Audio Quality ELO ↑** | 1959 | **2016** |
| **Speaker Similarity ELO ↑** | **2037** | 1898 |

## Performance

| Metric | DSM | Pocket TTS |
|---|---|---|
| **Hardware** | Apple Silicon GPU required | CPU (2 cores) |
| **Memory** | 3–6 GB GPU RAM | 200–400 MB system RAM |
| **Real-time factor** | ~1× on GPU | ~6× on MacBook Air M4 CPU |
| **First audio** | ~2.5s (acoustic delay warmup) | ~200ms |
| **Incremental text** | **Native** (open_stream → text chunks) | Full text required |

## Protocol & Server

| Dimension | DSM | Pocket TTS |
|---|---|---|
| **Protocol** | WebSocket (bidirectional, push PCM) | HTTP POST (streaming WAV response) |
| **Server** | ~700 lines custom asyncio+MLX | ~200 lines FastAPI |
| **Streaming** | Token-level incremental text → audio | Sentence-level, full text upfront |
| **Multi-voice** | 3 TTSGen instances, round-robin, cache swapping | Single model, voice states via lru_cache |
| **Dependencies** | moshi-mlx, MLX, sentencepiece, websockets | torch, safetensors, scipy, fastapi |
| **Python** | 3.12+ | 3.10–3.14 |

## Voice Cloning Pipeline (Pocket TTS)

```
Raw WAV → audio_read() → resample 24kHz → Mimi.encode_to_latent()
→ F.linear(_, speaker_proj_weight) → FlowLM prompt → KV cache state
→ export_model_state() → .safetensors (fast reload)
```

Voice state = FlowLM KV cache filled by processing reference audio.
Pre-compute once, save as `.safetensors`, reload instantly.

## Critical Trade-off

| Aspect | Winner | Why |
|---|---|---|
| Audio quality | Pocket TTS | ELO 2016 vs 1959 |
| Speaker similarity | DSM | ELO 2037 vs 1898 |
| First-audio latency | Pocket TTS | 200ms vs 2.5s |
| Incremental text streaming | **DSM** | Native; Pocket needs full text |
| CPU compatibility | Pocket TTS | No GPU needed |
| Voice cloning UX | Pocket TTS | Any WAV at runtime |
| Resource footprint | Pocket TTS | 10× smaller, 10× less memory |
| Integration effort | DSM | Already integrated; Pocket requires protocol rewrite |
| Server complexity | Pocket TTS | 200 lines vs 700 |
| Battery/power | Pocket TTS | CPU-only vs GPU-active |

**The central tension:** DSM's incremental text streaming is the app's
architectural differentiator (ADR-003, ADR-004). Pocket TTS wins on resources,
voice cloning, and simplicity but requires full sentences (not token-level text).
However, voice cloning is a hard requirement, and DSM's voice cloning weights
are gated/private — making Pocket TTS the only viable path for custom voices.

## Recommendation (revised 2026-05-13)

**Switch to Pocket TTS.** The gated DSM voice cloning model forces this choice.

1. Replace DSM WebSocket server with Pocket TTS (Python library or HTTP server)
2. Use `get_state_for_audio_prompt()` for voice cloning (WAV → voice state)
3. Export voice states as `.safetensors` for fast reload at startup
4. Adapt orchestrator/channel-pipeline for sentence-level requests
   (reuse existing `text-chunker.js` for sentence splitting)
5. Leverage `generate_audio_stream()` for streaming audio output per sentence

**Why not bridge:** The DSM `speaker_wavs` format depends on a private model.
The raw Mimi encoder output distribution differs by 12× in variance from
working embeddings. There is no viable conversion path without the gated model.

**Switching impact:**
- Protocol: WebSocket → HTTP POST with `StreamingResponse` (or direct Python API)
- Server: 700-line custom asyncio+MLX → Pocket TTS library (~200 lines)
- Pipeline: Rewrite KyutaiBackend, update channel-pipeline
- Benefits: native voice cloning, 200ms first audio, CPU-only, 10× less memory
- Deprecate: `server/tts-server-streaming.py`, `tts/kyutai-backend.js`

### Previous recommendation (superseded 2026-05-13)

*Bridge approach (2026-05-12): Use Pocket TTS as voice embedding pre-processor,
keep DSM for streaming synthesis. Invalidated upon discovering the
gated voice cloning model requirement.*
## External Resources

### Papers
- [Pocket TTS / CALM paper](https://arxiv.org/abs/2509.06926) — Table 12 has direct DSM comparison
- [DSM research paper](https://arxiv.org/html/2509.08753v2) — Delayed Streams Modeling architecture

### Repositories
- [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) — Python package, 100M params, CPU-only
- [Delayed Streams Modeling (DSM)](https://github.com/kyutai-labs/delayed-streams-modeling) — Our current model's upstream
- [moshi-mlx](https://github.com/kyutai-labs/moshi-mlx) — MLX port we use for Apple Silicon
- [Pocket TTS MLX port](https://github.com/jishnuvenugopal/pocket-tts-mlx) — Community MLX backend (potential bridge)
- [Pocket TTS ONNX export](https://github.com/KevinAHM/pocket-tts-onnx-export) — Browser-capable via ONNX Runtime Web
- [wasm-pocket-tts](https://github.com/LaurentMazare/xn/tree/main/wasm-pocket-tts) — Rust/WASM port, runs in browser

### Voice Repositories
- [Kyutai TTS Voices](https://huggingface.co/kyutai/tts-voices) — Pre-computed voice embeddings (DSM format)
- [Pocket TTS Voices](https://huggingface.co/kyutai/tts-voices) — Same repo, also compatible with Pocket TTS
- [Pocket TTS Model](https://huggingface.co/kyutai/pocket-tts) — Model weights (voice cloning requires license acceptance)

### Demos
- [Pocket TTS demo](https://kyutai.org/pocket-tts) — Browser-based, try voices live
- [Kyutai TTS page](https://kyutai.org/tts) — DSM overview and demos

### Technical Reports
- [Pocket TTS technical report](https://kyutai.org/pocket-tts-technical-report) — Architecture deep-dive
- [Kyutai TTS 1.6B announcement](https://kyutai.org/blog/2025-07-03-kyutai-tts-1-6b) — DSM architecture blog post

### Community Projects (reference for integration patterns)
- [pocket-tts-openai-streaming-server](https://github.com/teddybear082/pocket-tts-openai_streaming_server) — OpenAI-compatible streaming server wrapper
- [pocket-tts-wyoming](https://github.com/ikidd/pocket-tts-wyoming) — Home Assistant Voice integration via Wyoming protocol
- [sherpa-onnx Pocket TTS](https://github.com/k2-fsa/sherpa-onnx) — Multi-platform ONNX runtime with 12 language bindings

### Our ADRs
- `docs/adr/003-kyutai-tts-streaming-refactor.md` — Kokoro → DSM transition
- `docs/adr/004-streaming-tts-protocol.md` — Incremental text streaming protocol
