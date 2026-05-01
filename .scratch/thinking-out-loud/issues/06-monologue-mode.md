Status: needs-triage

# 06 — Monologue mode

## Parent

[Thinking Out Loud PRD](../PRD.md)

## What to build

Add a Mode toggle (Chorus/Monologue) to the UI. In Monologue, the Orchestrator solos one Channel at a time, auto-advancing to the next Model only after the current Channel's TTS finishes speaking. All three Columns still stream Reasoning text silently while waiting their turn. Mode is selectable before a Session starts and is locked during active Sessions.

End-to-end: switch to Monologue → ask a question → three Columns stream text, but only one Model speaks at a time. When the first finishes speaking, the second begins automatically. The user hears a clean sequence of distinct voices.

## Acceptance criteria

- [ ] `ui/mode-toggle.js` renders a segmented switch (Chorus / Monologue) next to the PromptSelector
- [ ] Default mode comes from `config.js` (`defaultMode`)
- [ ] Mode toggle is disabled during Thinking and Speaking states
- [ ] In Monologue, the Orchestrator activates only one Channel at a time
- [ ] Auto-advance: the next Model's Channel activates only after the current Channel's TTS completely finishes (all Sentence chunks played)
- [ ] All three Columns continue streaming Reasoning text during Monologue, including Models waiting their turn
- [ ] Waveforms show idle animation for non-speaking Channels, active animation for the speaking Channel
- [ ] After the last Model finishes, Session transitions to Done

## Blocked by

- `05-chorus-three-models` — needs the three-Model Orchestrator to extend with sequential mode
