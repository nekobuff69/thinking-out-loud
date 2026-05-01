# Issue #4 — Waveform visualization for one Model
## Blocker: #3

Implement GitHub issue #4 for repo nekobuff69/thinking-out-loud.

Fetch the issue with `gh issue view 4 --comments` to read the full spec.

Context: #3 has one Channel playing TTS audio with an AnalyserNode in the audio graph. The Column already shows the Model's Display name and streaming text. config.js has the Model's color. Read UBIQUITOUS_LANGUAGE.md — use terms: Waveform, AnalyserNode, Idle waveform, Column.

Goal: Attach AnalyserNode data to a canvas Waveform in the Column. Bars in the Model's color, real-time animation when audio plays, smooth transition to idle breathing animation when silent. Column header shows the Model's Display name.
