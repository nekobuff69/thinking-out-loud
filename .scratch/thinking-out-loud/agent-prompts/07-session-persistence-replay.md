# Issue #7 — Session persistence and replay
## Blocker: #5 — can run in parallel with #6, #8

Implement GitHub issue #7 for repo nekobuff69/thinking-out-loud.

Fetch the issue with `gh issue view 7 --comments` to read the full spec.

Context: #5 delivers completed Sessions (Done state). Read UBIQUITOUS_LANGUAGE.md — use terms: SessionStore, Replay, History, Recent questions, Eviction.

Goal: Build SessionStore with LocalStorage (save/load/list/clear with eviction at maxHistorySessions). Auto-save Sessions on Done. Build History UI to browse past Sessions. Clicking a Session replays: loads stored Reasoning text, re-synthesizes TTS with original Voices and mode. Save recent free-text Questions for reuse in PromptSelector.
