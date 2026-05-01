Status: needs-triage

# 03 — TTS pipeline for one Model

## Parent

[Thinking Out Loud PRD](../PRD.md)

## What to build

Add speech to the single-Model pipeline. Implement the TTSEngine with Kokoro backend, Sentence buffer with boundary detection and timeout, and AudioContext Channel creation. The Model's Reasoning is spoken aloud in its assigned Voice, with a 200ms Sentence gap between chunks. TTS stops at the Content boundary (Final answer never spoken) and respects the Token cap (~200 tokens, finishing the current Sentence chunk).

End-to-end: from issue #2's state (one Column streaming text) → hear the Reasoning spoken in the Model's Voice via browser audio. Speech is natural (sentence-bounded), pauses between sentences, and fades out gracefully at the Token cap.

## Acceptance criteria

- [ ] `tts/tts-engine.js` exports an abstract `TTSEngine` class with `load()`, `synthesize(text, voice) → AudioBuffer`, `destroy()` interface
- [ ] `tts/kokoro-backend.js` extends TTSEngine: loads Kokoro via Transformers.js (lazy, cached after first load), implements `synthesize` using the requested Voice
- [ ] Sentence buffer accumulates Reasoning tokens from StreamParser callbacks
- [ ] Buffer flushes to `synthesize()` on Sentence boundaries (`.`, `!`, `?`, `;`, newline) or Sentence timeout (~30 tokens)
- [ ] 200ms silence gap inserted between consecutive Sentence chunks during playback
- [ ] `audio/audio-graph.js` creates a single AudioContext with gain + panner + analyser for one Channel
- [ ] TTS stops when the Content boundary is hit: current Sentence chunk finishes, no new chunks start
- [ ] TTS stops when the Token cap is reached: current Sentence chunk finishes, then Channel goes silent
- [ ] TTS model downloads lazily on first Ask, cached by Transformers.js on subsequent page loads
- [ ] The Model's Reasoning text continues streaming in the Column during and after speech
- [ ] Full Reasoning text remains visible in the Column even beyond the Token cap (text is not truncated)

## Blocked by

- `02-single-llm-streaming-text` — needs streaming text flowing to have content for TTS
