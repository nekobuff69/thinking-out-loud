# ADR-006: Move LLM Inference from Local LM Studio to OpenRouter

## Status

Accepted — implemented 2026-11-23. Replaces the local LLM deployment assumed in ADR-003 and earlier.

## Context

The project was originally developed on an Apple Silicon Mac with 96 GB of RAM, where `gpt-oss-20b` could run locally through LM Studio on port 1234. The development machine is now a Windows laptop with a Ryzen 7 PRO 5850U, 16 GB RAM, and integrated Vega graphics. A 20B model needs roughly 12–13 GB of weights alone, which does not fit comfortably alongside the OS, browser, and local Pocket TTS server. CPU inference would also be too slow for the real-time, three-column experience.

Requirements that shaped the decision:

- Three concurrent reasoning streams with low first-token latency.
- The same model for all three columns; differences must come from persona system prompts.
- `reasoning` / `reasoning_content` fields must stream separately from the final answer.
- Keep voice cloning and TTS local (see ADR-005).

## Decision

Move LLM inference to **OpenRouter**, retaining the OpenAI-compatible client abstraction.

- `config.js`: all three models use `https://openrouter.ai/api/v1`; the model slug comes from `VITE_OPENROUTER_MODEL` (default `openai/gpt-oss-20b`) and the key from `VITE_OPENROUTER_API_KEY` in `.env` (git-ignored, injected by Vite at serve/build time). Internal model names are stable code names A/B/C (not the API model, not the role); old saved sessions with Qwen/Gemma/GPT-OSS are normalized on replay.
- `llm/providers/openai-compatible-provider.js`: sends `Authorization: Bearer <key>` and `max_tokens` (from `tts.llmMaxTokens`, default 1600) on each streaming request. It also reports `finish_reason: "length"` via an `onTruncated` callback so a cut-off thought is visible instead of silent.
- `llm/health-check.js`: sends the same Bearer header on `GET /models`.
- `session/orchestrator.js`: passes `apiKey` into health checks and provider construction; the provider cache key includes the key.
- TTS remains a local Pocket TTS server on port 8080. The local LLM server is no longer a runtime dependency.

## Rationale

OpenRouter speaks the OpenAI-compatible protocol already implemented in the codebase, so the change is configuration plus authentication headers — no new provider protocol. `gpt-oss-20b` runs on hosted hardware, preserving the reasoning quality and the `separate` reasoning format used by the UI. The alternative of shrinking the local model would change the artistic output and still compete with local TTS for RAM and CPU.

## Consequences

### Positive

- No local model server to start; only the TTS server and Vite dev server remain.
- Model quality and streaming latency no longer depend on the laptop's RAM or GPU.
- Switching models is a single `.env` variable change, subject to provider reasoning-field support.

### Trade-offs and risks

- **Prompts and reasoning text leave the browser.** The prior "everything local" property is gone.
- **API key is embedded in the browser bundle.** Vite injects `VITE_*` values at build time. Acceptable for a local art installation, but use a dedicated key with a monthly spend limit on OpenRouter; do not reuse a production key.
- **Network dependency and per-request cost.** An unavailable network or exhausted balance blocks all columns.
- **Legacy CLI scripts are not migrated.** `getReasoningContent.js` / `saveReasoning.js` do not forward `apiKey`, so they will get 401 from OpenRouter until updated. Browser flow is unaffected.
- **Provider-specific reasoning format.** OpenRouter returns `delta.reasoning` for `gpt-oss-20b`; the client reads both `delta.reasoning` and `delta.reasoning_content`. A model that returns neither produces empty reasoning columns in `separate` mode. Confirmed via a direct OpenRouter smoke test on 2026-11-23; full browser end-to-end verification is separate.
- **Generation length vs. a complete thought.** Reasoning tokens count toward `max_tokens`. Measured on `gpt-oss-20b`: 200 tokens cut a thought mid-sentence (`finish_reason: "length"`); ~1243 tokens let it finish. `llmMaxTokens` defaults to 1600 so thoughts complete. Raising it increases per-request cost and playback duration; truncation is now surfaced via `onTruncated` / `pipeline-truncated` / a column marker so it cannot pass silently.

### Verification

- `npm test` — 131 tests pass, including Bearer-header, absent-key, `max_tokens` from `llmMaxTokens`, and truncation-detection cases.
- `npm run typecheck` and `npm run build` — clean.
- Direct OpenRouter API smoke test — key valid, `delta.reasoning` present, `separate` parsing works.

## Alternatives not taken

- **Run a smaller local model (e.g. 7B).** Lower hardware need, but weaker reasoning and still consumes the RAM/CPU budget needed by local TTS.
- **Self-host an OpenAI-compatible server on a GPU box.** Full control and no per-token cost, but adds hardware and operational overhead outside this project's scope.
- **Move TTS to the cloud as well.** Rejected: voice cloning from the user's own WAV sample and sub-200 ms first-audio latency are already solved locally (ADR-005).

## References

- `config.js` — provider URLs, key/model wiring, TTS chunker parameters
- `docs/tts-benchmark-2026-11-23.md` — local TTS benchmarks and OpenRouter smoke test notes
- [OpenRouter API reference](https://openrouter.ai/docs/api-reference)
