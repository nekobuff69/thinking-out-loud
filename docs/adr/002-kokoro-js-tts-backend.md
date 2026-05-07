# ADR-002: Replace Transformers.js Pipeline with kokoro-js for TTS

## Status

Accepted — implemented May 2026.

## Context

On first run, the browser console showed three errors:

1. **`404 (Not Found)` on `processor_config.json`** — Transformers.js pipeline auto-detection tried to load a processor config that doesn't exist in the Kokoro model repo (Kokoro uses a `PreTrainedTokenizer`, not a `Processor`).

2. **`Unsupported model type: style_text_to_speech_2`** — The Kokoro model's `config.json` declares `model_type: "style_text_to_speech_2"`. When `pipeline("text-to-speech", modelId)` runs, it uses `AutoModelForTextToWaveform` to find the model class, but `style_text_to_speech_2` is not registered in that mapping. The model class (`StyleTextToSpeech2Model`) exists in transformers.js but the pipeline routing never reaches it.

3. **Endless loading spinner** — The `KokoroBackend.load()` rejection propagated to `orchestrator.start()`, but the state machine was stuck in `Loading` because the error bypassed the normal state transition path.

Investigation of `@huggingface/transformers@4.2.0` (latest at time of fix) confirmed: the pipeline routing gap persists in the newest release.

## Decision

Replace the `pipeline("text-to-speech", ...)` call with `kokoro-js` (`KokoroTTS.from_pretrained()`).

`kokoro-js` is the official JavaScript wrapper for Kokoro, published by xenova (same author as transformers.js). It imports `StyleTextToSpeech2Model` directly from transformers.js, bypassing the broken pipeline auto-detection entirely.

### Before

```js
import { pipeline } from "@huggingface/transformers";

this.#pipeline = await pipeline("text-to-speech", modelId, { dtype: "q8" });
// pipeline() → AutoModelForTextToWaveform → model_type lookup → FAIL
```

### After

```js
import { KokoroTTS } from "kokoro-js";

this.#tts = await KokoroTTS.from_pretrained(modelId, { dtype: "q8" });
// KokoroTTS → StyleTextToSpeech2Model.from_pretrained() → SUCCESS
```

### Changes

- **`tts/kokoro-backend.js`** — Replaced `pipeline()` with `KokoroTTS`. The `TTSEngine` interface (`load()`, `synthesize(text, voice)`, `destroy()`) is unchanged — no downstream callers needed modification.
- **`config.js`** — Updated TTS model ID from `onnx-community/Kokoro-82M-ONNX` to `onnx-community/Kokoro-82M-v1.0-ONNX` (the v1.0 repo that kokoro-js expects for voice binaries).
- **`test/orchestrator.test.js`** — Fixed pre-existing mock gap: added `createChannel()` and `getContext()` to `mockAudioGraph`.

## Consequences

### Positive

- **Bug fixed:** All three console errors eliminated. Model loads and synthesizes correctly.
- **Better API:** `KokoroTTS.generate(text, { voice })` returns `RawAudio` directly — simpler than the pipeline's `{ audio, sampling_rate }` envelope.
- **Built-in streaming:** `kokoro-js` provides `TextSplitterStream` + `tts.stream()` for incremental synthesis. This maps onto our existing `SentenceBuffer` → `TTSPlaybackQueue` pipeline and could enable even smoother streaming in a future iteration.
- **Official support:** `kokoro-js` is actively maintained and used in the official Hugging Face Kokoro demo spaces.

### Negative / Trade-offs

- **Additional dependency:** `kokoro-js` (30.4 MB unpacked) is added to `package.json`. However, it depends on `@huggingface/transformers` which we already have — net new size is moderate (phonemizer + Kokoro model code).
- **Still uses transformers.js underneath:** This is not a replacement — `kokoro-js` wraps it. We keep both dependencies rather than eliminating transformers.js. If transformers.js v5+ introduces breaking changes, both libs must be updated together.

### Not taken: alternative options

- **Switch to a supported TTS model (e.g. Vits)** — Would work immediately but degrades audio quality significantly.
- **Fork transformers.js to add the mapping** — Fragile; would break on every `@huggingface/transformers` update.
- **Use ONNX Runtime directly** — Highest effort, would require reimplementing phonemization, tokenization, and voice vector loading.

## Related

- `CONTEXT.md` — TTS layer description updated
- `README.md` — TTS model reference updated
- `UBIQUITOUS_LANGUAGE.md` — TTS model definition updated
- `docs/agents/domain.md` — TTS directory description consistent
