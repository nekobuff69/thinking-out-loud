Status: needs-triage

# 07 — Session persistence and replay

## Parent

[Thinking Out Loud PRD](../PRD.md)

## What to build

Implement SessionStore with LocalStorage for auto-saving completed Sessions. Build a History UI listing past Sessions. Clicking a past Session replays it: loads the stored Reasoning text for all three Models, re-synthesizes TTS audio with the original Voices and mode (Chorus or Monologue). Recent free-text Questions are saved for quick reuse in the PromptSelector.

End-to-end: finish a Session → it auto-saves → open History panel → see the Session listed with question text, timestamp, and mode → click it → hear and see the full Session replay.

## Acceptance criteria

- [ ] `session/storage.js` implements SessionStore: `save(session)`, `load(id)`, `list()`, `clear()`
- [ ] Session objects include: id, timestamp, question text, mode, per-Model reasoning text (full, not truncated), Display names, Colors, Voices
- [ ] `save()` serializes to LocalStorage, `load()` deserializes
- [ ] Eviction: when stored Sessions exceed `maxHistorySessions`, oldest Session is removed
- [ ] `list()` returns all stored Sessions sorted by timestamp descending
- [ ] Orchestrator calls `save()` automatically when Session reaches Done state
- [ ] `ui/history.js` renders a History panel showing past Sessions (question text, timestamp, mode)
- [ ] Clicking a past Session triggers replay: loads reasoning text, creates a new Session in replay mode
- [ ] Replay re-synthesizes TTS from stored text (not re-fetched from LLMs)
- [ ] Replay uses the original mode (Chorus/Monologue) and original Voice per Model
- [ ] Recent free-text Questions saved in LocalStorage (separate from Sessions)
- [ ] PromptSelector shows recent Questions for quick re-selection

## Blocked by

- `05-chorus-three-models` — needs completed Sessions to persist and replay
