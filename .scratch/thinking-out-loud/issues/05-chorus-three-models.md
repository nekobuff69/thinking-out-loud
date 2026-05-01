Status: needs-triage

# 05 — Chorus mode: three Models simultaneously

## Parent

[Thinking Out Loud PRD](../PRD.md)

## What to build

Extend the Orchestrator to run all three Models from config concurrently. Each Model gets its own Column, Channel, Voice, Panning position, and Color. The AudioContext mixes all three Channels simultaneously with Ducking when multiple voices overlap. The three Columns display side-by-side.

End-to-end: ask a question → three Columns appear side-by-side, each streaming text in its Color, each speaking in its Voice from its Pan position (left/center/right). Voices overlap naturally. The user hears three distinct "minds" thinking at once.

## Acceptance criteria

- [ ] `session/orchestrator.js` manages a full Session lifecycle: Idle → Loading → Thinking → Speaking → Done
- [ ] Orchestrator creates LLM fetch streams for all three Models concurrently
- [ ] Each Model's stream is routed through its own StreamParser, Sentence buffer, TTSEngine, and AudioGraph Channel
- [ ] AudioGraph creates three independent Channels, each with gain + panner + analyser
- [ ] Channels are panned according to config: left (−0.5), center (0), right (0.5)
- [ ] Ducking: when two or more Channels play simultaneously, gain nodes attenuate slightly to prevent clipping
- [ ] Three Columns render side-by-side in the dark theater layout
- [ ] Each Column displays its Model's Display name, Color-assigned text, and Color-assigned Waveform
- [ ] UI locked during Thinking and Speaking states (no new Ask)
- [ ] Session transitions to Done when all Channels finish: all LLM streams closed, all TTS finished
- [ ] PromptSelector and Ask button re-enabled in Done state

## Blocked by

- `04-waveform-one-model` — needs the single-Model Column with Waveform as the foundation to replicate for three
