Status: needs-triage

# 08 — Session lifecycle polish and error handling

## Parent

[Thinking Out Loud PRD](../PRD.md)

## What to build

Polish the full Session experience: Loading state UI while TTS model downloads and LLM health checks run, graceful partial failure when individual Models are unreachable, soft stop button, and tab-blur handling. Apply dark theater visual polish consistently across all UI surfaces.

End-to-end: hit Ask → see a loading indicator while TTS prepares and Models are pinged → if one Model fails, its Column shows an error state while others proceed normally → press Stop mid-Session → current Sentence chunk finishes, then silence → switch tabs → playback continues in background.

## Acceptance criteria

- [ ] Loading state: after Ask, UI shows a loading indicator while TTS model loads and LLM provider health pings run
- [ ] LLM health ping: Orchestrator sends a lightweight request to each Model's URL before starting the real Session
- [ ] Graceful partial failure: if one Model is unreachable, its Column shows an error state (e.g. "Qwen — unavailable") and the other Models proceed
- [ ] If all Models are unreachable, a blocking error is shown: "No LLM providers reachable — check your configuration"
- [ ] Soft stop button is visible during Thinking and Speaking states
- [ ] Stop: current Sentence chunk finishes playing, then all LLM streams are aborted and Channels go silent
- [ ] Tab blur: Session playback continues uninterrupted (AudioContext is not suspended)
- [ ] Tab return: UI is up-to-date with current Session state (no catch-up lag)
- [ ] UI locked during Loading, Thinking, and Speaking states (PromptSelector and Mode toggle disabled, Ask button disabled)
- [ ] Dark theater visual theme applied consistently: black background, colored text per Model, styled PromptSelector cards, styled Mode toggle, styled History panel
- [ ] Column error state visually distinct from normal idle/active states

## Blocked by

- `05-chorus-three-models` — needs the full Session lifecycle and multi-Model Orchestrator to add polish and error handling
