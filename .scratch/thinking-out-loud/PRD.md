# Thinking Out Loud

## Problem Statement

A user wants to witness how different large language models *think* — not what sanitized answers they produce, but their raw, unpolished reasoning process. Currently, AI interfaces hide this interiority behind a single polished output. The user cannot compare how different "minds" approach the same question, hear their thought cadence, or observe the contrasts between models. For an artistic exploration of AI consciousness, identity, and agency, there is no tool that surfaces the thinking block as an auditory and visual experience.

## Solution

A browser-based application where the user types or selects a philosophical question. Three different LLMs (served locally via an OpenAI-compatible provider like LM Studio) receive the question simultaneously and stream their reasoning — not their final answer — back to the browser. Each model's reasoning block is parsed from the streaming response, rendered as live text in its own column, and spoken aloud by a distinct TTS voice with a corresponding colored waveform. The user hears three "minds" thinking out loud at once (Chorus mode) or sequentially (Monologue mode), and can replay past sessions. The experience is dark, theatrical, and monospaced — a performance of machine cognition.

## User Stories

1. As a user, I want to type a free-text question into an input field, so that I can ask the LLMs anything I'm curious about.
2. As a user, I want to select from a list of curated philosophical prompts, so that I can explore the artistic theme even when I don't know what to ask.
3. As a user, I want to see the curated prompts alongside the free-text input, so that the prompts set the thematic tone without limiting my freedom.
4. As a user, I want to hit an "Ask" button to start a session, so that I explicitly initiate the experience rather than having it trigger automatically.
5. As a user, I want the app to call three different LLMs simultaneously, so that I can compare how different models think about the same question.
6. As a user, I want the app to extract only the reasoning block from each LLM's response and ignore the final answer, so that I witness pure thought, not polished output.
7. As a user, I want each model's reasoning to appear as streaming text in its own column on screen, so that I can visually track each model's thought process in real time.
8. As a user, I want each column to use monospaced typography, so that the text feels raw and machine-like rather than typeset.
9. As a user, I want each column to auto-scroll to the latest text as it streams in, so that I see the newest thought without manual scrolling.
10. As a user, I want to manually scroll back through a column's text, so that I can re-read earlier reasoning while new text continues arriving.
11. As a user, I want a subtle indicator when I've scrolled up and new content is arriving below, so that I know the model is still thinking.
12. As a user, I want each model's reasoning to be spoken aloud by a distinct TTS voice, so that I can hear each mind's "voice" as different.
13. As a user, I want TTS to synthesize at natural sentence boundaries, so that the speech sounds fluid rather than robotic staccato.
14. As a user, I want to hear approximately 60 seconds of speech per model (roughly 200 tokens of reasoning), so that the experience has a natural duration without the models speaking endlessly.
15. As a user, I want the TTS to finish the current sentence when it hits the token cap, so that the voice fades out naturally rather than cutting mid-word.
16. As a user, I want the TTS to never speak the model's final answer (only reasoning), so that the experience stays focused on thought, not output.
17. As a user, I want to see a live colored waveform for each model's voice, so that I can visually associate sound with each column even during silent moments.
18. As a user, I want each model's waveform to show an idle breathing animation when that model is silent, so that I know the channel is still active.
19. As a user, I want each model to have a distinct identifying color (applied to text and waveform), so that I can quickly distinguish the three voices visually.
20. As a user, I want each model to have a human-readable display name (not a raw model ID), so that I can refer to them naturally.
21. As a user, I want to experience the default "Chorus" mode where all three voices speak simultaneously, so that I can hear the three minds thinking at once.
22. As a user in Chorus mode, I want each voice panned to a different stereo position (left, center, right), so that I can spatially separate the overlapping voices.
23. As a user, I want to switch to "Monologue" mode before starting a session, so that I can hear each model speak sequentially instead of simultaneously.
24. As a user in Monologue mode, I want the next model to begin only after the current model's TTS has finished, so that there is clear separation between voices.
25. As a user in Monologue mode, I want all three columns to continue streaming text even when only one is speaking, so that I can see all models are still thinking.
26. As a user, I want the app to display a loading state (TTS model download, LLM health check) after I hit Ask, so that I know setup is in progress.
27. As a user, I want the session to gracefully continue if one LLM fails to connect, so that a single model failure doesn't end the entire experience.
28. As a user, I want a failed model's column to show an error state indicating it couldn't be reached, so that I know what happened.
29. As a user, I want to press a "Stop" button during a session, so that I can end the experience early if I choose.
30. As a user, I want the Stop button to let the current TTS sentence finish before silencing, so that the stop feels natural rather than jarring.
31. As a user, I want the session to continue playing even if I switch browser tabs, so that I can listen to the thinking in the background.
32. As a user, I want to replay a past session and hear the TTS voices again, so that I can revisit interesting thoughts.
33. As a user, I want past sessions saved automatically (full reasoning text), so that I don't lose thoughts I want to revisit.
34. As a user, I want to see a history list of my past sessions, so that I can browse and select one to replay.
35. As a user, I want recent free-text questions saved so I can quickly reuse them, so that I don't have to retype questions I've asked before.
36. As a user, I want the visual theme to be dark (black background, colored text, glowing waveforms), so that the experience feels theatrical and focused.
37. As a user, I want the UI locked during an active session (no new question input), so that I'm fully immersed in the current experience.
38. As a user, I want the app to function entirely in the browser with no server-side component (except the local LLM provider), so that it's self-contained and easy to run.
39. As a user, I want the app to work with any OpenAI-compatible local inference engine (not just LM Studio), so that I can use my preferred provider.

## Implementation Decisions

### Architecture

The application is a single-page browser app with no build step, using vanilla JavaScript ES modules. It communicates directly with local LLM providers via HTTP fetch to their OpenAI-compatible chat completions endpoint. TTS runs entirely in the browser using Transformers.js and a configurable backend (Kokoro initially). No server component exists beyond the LLM provider(s) the user runs locally.

### Module breakdown

**TTSEngine (deep module):** An abstract class interface with `load()`, `synthesize(text, voice)`, and `destroy()` methods. `load()` handles model download and initialization (cached by the browser after first load). `synthesize()` takes text and a voice identifier, returns an AudioBuffer. `destroy()` cleans up runtime resources. The concrete backend (Kokoro initially) is selected via configuration. The caller does not know which TTS model is in use.

**StreamParser (deep module):** Consumes a ReadableStream from an OpenAI-compatible streaming chat completion response. Parses SSE chunks, extracts reasoning content deltas (field names like `reasoning_content` or `reasoning`), and fires callbacks: `onReasoningToken` for each token of thought, `onContentStart` when the model transitions to final answer output. The caller is shielded from SSE parsing, JSON deserialization, and provider-specific field name differences.

**AudioGraph (deep module):** Manages a single AudioContext. `createModelChannel(pan, color)` creates a per-model audio pipeline: gain node, stereo panner node, and AnalyserNode for waveform data. Returns a source connector and the analyser. `destroy()` closes the AudioContext. Spatial positioning, volume ducking during overlap, and analyser data extraction are internal.

**SessionStore (deep module):** Stores and retrieves session objects (question, per-model reasoning text, timestamps, mode) in the browser's LocalStorage. `save(session)`, `load(id)`, `list()`, `clear()`. Handles serialization, quota management, and eviction of oldest sessions when `maxHistorySessions` is exceeded. Sessions include full reasoning text even beyond the TTS token cap.

**Orchestrator (shallow module):** Coordinates one session from Idle through Loading, Thinking, Speaking, to Done. Creates per-model LLM fetch streams, routes tokens through StreamParser → TTS sentence buffer → TTSEngine → AudioGraph → DOM. Manages Chorus mode (all three concurrently) and Monologue mode (sequential, waiting for TTS completion before advancing). Handles stop requests with soft-stop behavior (finish current TTS sentence, then abort streams). Emits events for UI modules to observe.

**Column UI:** Renders a single model's column: display name, monospaced reasoning text container with manual scroll and "new content below" indicator, canvas waveform driven by AnalyserNode data, and error state. The waveform shows amplitude bars in the model's color, with an idle breathing animation when silent.

**PromptSelector UI:** Renders the curated prompt list (clickable cards) and a free-text input with Ask button. Shows recent free-text questions from LocalStorage. Disabled during active sessions.

**ModeToggle UI:** A segmented switch for Chorus / Monologue, settable before a session starts. Disabled during active sessions.

**History UI:** Lists past sessions (question, timestamp, duration, mode). Clicking a session loads its reasoning text and triggers TTS re-synthesis for full replay.

### Configuration

A JavaScript module exports the full app configuration:

- Default playback mode (chorus or monologue)
- Array of 5 curated philosophical prompts
- Array of model definitions, each with: display name, provider identifier, base URL (supports per-model URLs for multi-instance setups), model identifier string, TTS voice identifier, display color, and stereo pan position
- TTS settings: model backend selector, maximum tokens to synthesize, sentence timeout token count
- System prompt used for all models
- Maximum history sessions for LocalStorage eviction

### Streaming and TTS flow

LLM streaming responses are parsed token by token. Reasoning tokens accumulate in a per-model sentence buffer. When a sentence-ending punctuation mark (`.`, `!`, `?`, `;`, newline) is encountered, or when the buffer exceeds the sentence timeout threshold, the buffer is flushed and sent to TTS synthesis. A 200ms silence gap is inserted between sentence chunks. TTS synthesis of the next chunk can proceed concurrently with playback of the current chunk.

TTS stops when either: the model's reasoning stream ends and its final sentence finishes playing, or the token cap is reached (the current sentence finishes but no new sentences start). The final answer block (model's `content` field) is never spoken.

The TTS model is downloaded lazily on the first Ask of a page session and cached by the browser's Transformers.js cache (IndexedDB). Subsequent page loads use the cached model.

### Audio mixing

Each model has an independent channel in a single AudioContext: source → gain node → stereo panner → AnalyserNode → destination. Chorus mode plays all three simultaneously with spatial separation. Monologue mode solos one channel at a time. When multiple voices overlap in Chorus, gain nodes are subtly ducked to prevent clipping.

### Session lifecycle

Sessions move through states: Idle (input enabled) → Loading (TTS model check, LLM health pings) → Thinking (LLM streams active, TTS playing) → Speaking (streams ended, TTS finishing) → Done (saved to LocalStorage, replay available). A soft-stop button aborts streams after finishing the current TTS sentence. Browser tab blur does not pause the session. UI is locked during Thinking and Speaking states.

### Error handling

The app degrades gracefully: if an individual LLM is unreachable, its column shows an error state and the remaining models proceed. If all LLMs are unreachable (provider not running), a blocking error is shown. TTS synthesis failures for one model silence that channel but leave text streaming intact. Connection errors trigger a single retry before falling back to error state.

### Browser compatibility

Targets modern browsers with Web Audio API and ES module support. Transformers.js handles WebGPU acceleration for TTS where available, with CPU fallback.

## Testing Decisions

No tests are written at this stage. When tests are introduced, they should focus on external behavior of deep modules:

- **What makes a good test:** Tests verify observable behavior — inputs and outputs — not internal state or implementation details. Mocks are used for external dependencies (network, AudioContext, Transformers.js runtime). Test interfaces, not code paths.
- **Modules to test:** TTSEngine (mock backend, verify synthesize returns valid AudioBuffer shape), StreamParser (feed mock SSE chunks, verify correct callbacks), AudioGraph (verify analyser produces data, verify pan values), SessionStore (round-trip save/load, eviction behavior).
- **Prior art:** The existing codebase (`saveReasoning.js`, `getReasoningContent.js`) has no tests. This PRD establishes the testing approach for any future work.

## Out of Scope

- A UI for editing the configuration file (editing is done directly in config.js)
- Server-side components or cloud-hosted LLM providers (local inference only)
- Mobile-responsive layout (desktop-first; three-column layout requires sufficient width)
- User authentication or multi-user support
- Streaming audio to external devices or Bluetooth
- Exporting sessions to external formats
- Custom TTS voice training or upload (configurable to support this later, but not built now)
- Real-time user microphone input or voice-based questions
- Persisting audio recordings (only reasoning text is stored; audio is re-synthesized on replay)
- Performance optimization for models larger than the three currently configured
- The ComfyUI image generation functionality (removed from this project)

## Further Notes

- The existing files `getReasoningContent.js`, `saveReasoning.js`, and `normalizeModelName.js` are kept as reference but are not part of the new application. The ComfyUI-related files (`triggerWorkflow.js`, `workflowTemplate.js`, `getWorkflowWithRandomSeed.js`) are removed. The `data/` directory has been renamed to `legacy-test-run-data/`.
- The TTS abstraction is designed so that a future custom voice model (e.g., the user's own voice) can be plugged in by implementing the TTSEngine interface.
- The curated prompts may be refined later; the initial five are starting points aligned with the artistic themes of consciousness, identity, and agency.
- The minimum token cap for TTS (200 tokens ≈ 60 seconds) was chosen based on average speech rate (~150 words per minute at ~1.3 tokens per word). Models may think much longer than this; the full reasoning text is always preserved in the session even if not all of it is spoken.
