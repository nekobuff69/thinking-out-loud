Status: needs-triage

# 04 — Waveform visualization for one Model

## Parent

[Thinking Out Loud PRD](../PRD.md)

## What to build

Attach an AnalyserNode to the Model's Channel and render a live canvas Waveform in the Column. The Waveform uses the Model's Color and shows amplitude bars when audio is playing, switching to an idle breathing animation when the Channel is silent. The Column header shows the Model's Display name.

End-to-end: from issue #3's state (one Column with text + audio) → see a colored Waveform animating in sync with the spoken Reasoning. When the Model pauses between Sentence chunks or when TTS ends, the Waveform shows a gentle idle pulse.

## Acceptance criteria

- [ ] `audio/audio-graph.js` exposes the AnalyserNode's frequency/amplitude data for the Column to consume
- [ ] `audio/waveform.js` renders a canvas Waveform in the Model's Column, driven by AnalyserNode data
- [ ] Waveform bars are rendered in the Model's Color
- [ ] When audio is playing, Waveform animates in real-time reflecting amplitude
- [ ] When the Channel is silent (between Sentence chunks or after TTS stops), Waveform shows an idle breathing/pulsing animation
- [ ] Waveform transitions smoothly between active and idle states
- [ ] Column header displays the Model's Display name (from config)

## Blocked by

- `03-tts-pipeline-one-model` — needs AudioContext Channel with AnalyserNode and active TTS to visualize
