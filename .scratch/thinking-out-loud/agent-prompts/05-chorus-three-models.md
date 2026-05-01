# Issue #5 — Chorus mode: three Models simultaneously
## Blocker: #4

Implement GitHub issue #5 for repo nekobuff69/thinking-out-loud.

Fetch the issue with `gh issue view 5 --comments` to read the full spec.

Context: #4 has one full Column (text + Waveform + TTS). config.js has three Models with url, voice, color, and pan fields. Read UBIQUITOUS_LANGUAGE.md — use terms: Orchestrator, Chorus, Panning, Ducking, Session lifecycle states (Idle→Loading→Thinking→Speaking→Done).

Goal: Build the Orchestrator to manage a full Session lifecycle. Query all three Models concurrently. Each gets its own Column + Channel + StreamParser + Sentence buffer + TTSEngine pipeline. AudioContext creates 3 Channels with Panning (left -0.5, center 0, right 0.5) and Ducking on overlap. Session transitions through all states. UI locked during Thinking/Speaking, re-enabled in Done.
