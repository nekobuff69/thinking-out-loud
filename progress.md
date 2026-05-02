# Progress

## Status
In Progress

## Tasks
- [x] #18: Remove dead State.Stopped branches from TTSPlaybackQueue
- [ ] #15: Restore LLM stream configurability and fix URL handling
- [x] #16: Clean up ChannelPipeline stream lifecycle + Orchestrator error swallowing
- [ ] #17: Fix minor nits (gitignore newline + waveform controller contract)

## Files Changed
- tts/playback-queue.js — removed 16 lines of dead code (3 unreachable State.Stopped branches)
- session/channel-pipeline.js — removed redundant #streamActive assignment, fixed abort signal listener leak
- session/orchestrator.js — log non-abort stream errors instead of silently swallowing

## Notes
