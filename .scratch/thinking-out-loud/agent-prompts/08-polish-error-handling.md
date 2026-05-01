# Issue #8 — Session lifecycle polish and error handling
## Blocker: #5 — can run in parallel with #6, #7

Implement GitHub issue #8 for repo nekobuff69/thinking-out-loud.

Fetch the issue with `gh issue view 8 --comments` to read the full spec.

Context: #5 delivers the full Session lifecycle. Read UBIQUITOUS_LANGUAGE.md — use terms: Loading, Soft stop, graceful partial failure.

Goal: Polish the experience. Loading state UI (TTS download + LLM health pings). Graceful partial failure: unreachable Models show error state in their Column, others proceed. Blocking error if all Models fail. Soft stop button (finish current Sentence chunk, abort streams). Tab blur continues playback. Dark theater visual polish across all UI. UI locked during Loading/Thinking/Speaking.
