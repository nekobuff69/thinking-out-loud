# Issue #6 — Monologue mode
## Blocker: #5

Implement GitHub issue #6 for repo nekobuff69/thinking-out-loud.

Fetch the issue with `gh issue view 6 --comments` to read the full spec.

Context: #5 delivers Chorus mode with three simultaneous Models. config.js has defaultMode. The Orchestrator manages the Session lifecycle. Read UBIQUITOUS_LANGUAGE.md — use terms: Monologue, Mode toggle, auto-advance.

Goal: Add a Mode toggle (Chorus/Monologue) to the UI. In Monologue, Orchestrator solos one Channel at a time, auto-advancing only after the current Channel's TTS completely finishes. All three Columns still stream Reasoning text silently. Mode is selectable before a Session and locked during active Sessions. Default from config.
