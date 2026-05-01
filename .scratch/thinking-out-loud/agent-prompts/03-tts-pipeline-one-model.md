# Issue #3 — TTS pipeline for one Model
## Blocker: #2

Implement GitHub issue #3 for repo nekobuff69/thinking-out-loud.

Fetch the issue with `gh issue view 3 --comments` to read the full spec.

Context: #2 has one Column streaming Reasoning text from one Model. config.js has the Model's voice field (Kokoro voice ID). Transformers.js is already in dependencies. Read UBIQUITOUS_LANGUAGE.md — use terms: TTSEngine, Voice, Sentence buffer, Sentence boundary, Sentence chunk, Sentence gap, Token cap, Content boundary, Channel.

Goal: Add speech. Build the abstract TTSEngine class, Kokoro backend (lazy load via Transformers.js), Sentence buffer with boundary detection (.!?;\n) and ~30 token timeout, 200ms gap between chunks. Create AudioContext with one Channel (gain + panner). TTS stops at Content boundary or Token cap (~200 tokens). Full Reasoning text stays visible beyond the cap.
