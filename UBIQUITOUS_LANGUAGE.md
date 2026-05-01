# Ubiquitous Language

## Session lifecycle

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Session** | A single round-trip: one question asked, three LLMs respond with reasoning, audio plays, results are saved | Run, cycle, generation |
| **Question** | The text the user asks — either a curated prompt or free-text input | Query, prompt, input |
| **Curated prompt** | One of five pre-written philosophical questions that frame the artistic theme | Preset, starter, suggested question |
| **Free-text question** | A user-typed question not from the curated list | Custom prompt, typed input |
| **Ask** | The user action that starts a session (clicking the Ask button) | Submit, go, start, run |
| **Loading** | Session state: TTS model checking and LLM provider health pings | Warm-up, setup, preparing |
| **Thinking** | Session state: LLM reasoning streams are active and TTS is playing | Streaming, generating, running |
| **Speaking** | Session state: LLM streams have ended but TTS is finishing buffered sentences | Tail, finishing, trailing |
| **Done** | Session state: all playback complete, session saved, replay available | Finished, complete, ended |
| **Stop** | User action that ends a session early via a soft stop | Cancel, abort, kill, mute |
| **Soft stop** | Finish the current TTS sentence, then abort streams and silence audio | Graceful stop, fade-stop |
| **Replay** | Re-synthesize TTS audio from a past session's stored reasoning text | Playback, listen again, re-listen |
| **History** | The list of past saved sessions browsable for replay | Archive, past sessions, log |

## LLM domain

| Term | Definition | Aliases to avoid |
|---|---|---|
| **LLM** | A large language model running locally that receives a question and produces reasoning | AI, bot, agent, mind |
| **Model** | A specific LLM identified by architecture and weights (e.g. Qwen, Nemotron) | LLM instance, engine, brain |
| **Provider** | The local inference server that hosts and runs models (e.g. LM Studio) | Server, backend, inference engine, runtime |
| **Reasoning** | The LLM's internal thought process — the `reasoning_content` field in the API response | Thinking, chain of thought, internal monologue, reasoning block |
| **Reasoning content** | The raw text of the LLM's reasoning, streamed token by token | Thinking block, thought stream, reasoning stream |
| **Final answer** | The LLM's polished output — the `content` field in the API response. Deliberately suppressed. | Response, output, answer, completion |
| **Content boundary** | The point in the stream where the LLM transitions from reasoning to final answer | Cut point, answer start, switch |
| **Streaming** | Receiving LLM output token-by-token via SSE as it is generated | Live, real-time, chunked |
| **Token** | A single unit of text from the LLM stream (sub-word or punctuation) | Piece, fragment, chunk (when referring to text, not audio) |
| **Token cap** | The maximum number of reasoning tokens (~200) that are synthesized to speech | Speech limit, TTS cutoff, token budget |
| **System prompt** | The instruction given to all models before the question (e.g. "You are a critical thinker") | System message, preamble, context |

## TTS and audio domain

| Term | Definition | Aliases to avoid |
|---|---|---|
| **TTS** | Text-to-speech: the browser-side synthesis that converts reasoning text into spoken audio | Speech synthesis, voice synthesis, audio generation |
| **TTS model** | The speech synthesis model loaded in the browser (e.g. Kokoro) | Speech engine, voice model, synthesis backend |
| **Voice** | A distinct speaker identity within a TTS model, assigned to one model | Speaker, persona, voice preset, timbre |
| **Sentence buffer** | Accumulated reasoning tokens waiting for a sentence boundary before TTS synthesis | Token queue, text buffer, pending text |
| **Sentence boundary** | Punctuation (`.`, `!`, `?`, `;`, newline) that triggers TTS synthesis of the buffered text | Break point, flush trigger, end-of-sentence |
| **Sentence chunk** | A complete sentence flushed from the buffer and sent to TTS | Utterance, segment, speech unit |
| **Sentence gap** | The 200ms silence inserted between consecutive sentence chunks | Pause, beat, breath, silence, interval |
| **Sentence timeout** | A fallback: if no sentence boundary arrives after ~30 tokens, synthesize anyway | Force-flush, timeout flush, chunk limit |
| **AudioContext** | The browser's Web Audio API context managing all audio routing and playback | Audio graph, audio engine, sound system |
| **Channel** | A per-model audio pipeline: gain node → stereo panner → AnalyserNode → output | Audio lane, voice lane, audio strip |
| **Panning** | Stereo spatial positioning of a channel (left, center, right) | Spatial audio, stereo position, placement |
| **Ducking** | Subtle volume reduction on all channels when multiple voices overlap | Volume attenuation, gain reduction |
| **AnalyserNode** | The Web Audio API node that extracts real-time frequency/amplitude data for waveform rendering | Audio analyser, FFT node |

## Playback modes

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Chorus** | Default mode: all three voices speak simultaneously with spatial panning | Simultaneous, concurrent, ensemble, polyphony |
| **Monologue** | Optional mode: voices speak sequentially, each waiting for the previous to finish | Sequential, solo, serial, one-at-a-time |
| **Mode toggle** | The UI switch that selects Chorus or Monologue before a session starts | Mode selector, playback switch |

## Visual domain

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Column** | A vertical panel in the UI representing one model — contains display name, reasoning text, and waveform | Pane, panel, slot, lane |
| **Waveform** | A live canvas visualization of a channel's AnalyserNode data, rendered in the model's color | Audio viz, sound wave, oscilloscope, bars |
| **Idle waveform** | The gentle breathing/pulsing animation shown when a channel is silent | Standby animation, resting waveform, idle pulse |
| **Display name** | The human-readable name for a model shown in the UI (e.g. "Qwen", not "qwen_qwen3-30b") | Label, title, heading |
| **Color** | The distinguishing hex color assigned to a model, applied to text and waveform | Hue, tint, theme color |
| **Dark theater** | The visual theme: black background, colored text, glowing waveforms | Dark mode, cinematic theme, stage |

## Persistence

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Session store** | LocalStorage-based storage for past session data (question + per-model reasoning text + metadata) | History store, session database |
| **Eviction** | Removing the oldest session when the max history limit is exceeded | Pruning, cleanup, rotation |
| **Recent questions** | Free-text questions temporarily saved in LocalStorage for quick reuse | Question history, past prompts |

## Relationships

- A **Session** is started by an **Ask** action with one **Question**
- A **Session** operates in exactly one mode: **Chorus** or **Monologue**
- A **Session** queries three **Models**, each served by a **Provider**
- Each **Model** produces one stream of **Reasoning** and one **Final answer**
- The **Final answer** is detected at the **Content boundary** and never spoken or displayed
- **Reasoning** is divided into **Sentence chunks** at **Sentence boundaries** (or **Sentence timeout**)
- Each **Sentence chunk** is synthesized by the **TTS model** using the model's assigned **Voice**
- Each **Model** has one **Channel** in the **AudioContext**, with its own **Panning** position
- Each **Channel** has one **AnalyserNode** that drives the **Waveform** in that model's **Column**
- A **Column** shows the **Display name**, streaming reasoning text, and **Waveform** in the model's **Color**
- **TTS** stops when the **Token cap** is reached (current **Sentence chunk** finishes, no new chunks start)
- A **Stop** action triggers a **Soft stop**: finish the current **Sentence chunk**, then abort
- A **Replay** loads a past **Session** from the **Session store** and re-synthesizes audio from stored **Reasoning**
- The **Session store** applies **Eviction** when stored **Sessions** exceed the configured maximum

## Example dialogue

> **Dev:** "When the user hits **Ask** in **Chorus** mode, do I start all three **Channels** at once?"
>
> **Domain expert:** "Yes — fire all three LLM fetches simultaneously. Each **Model** starts its **Reasoning** stream independently. The first **Channel** to receive a **Sentence boundary** starts speaking first. That's the point of **Chorus** — asynchronous, overlapping voices."
>
> **Dev:** "And the **TTS model** — does it queue **Sentence chunks** per **Channel**, or synthesize them in some global order?"
>
> **Domain expert:** "Per **Channel**. Each **Channel** has its own **Sentence buffer** that flushes to its own synthesis pipeline. The **AudioContext** mixes them. The only shared concern is **Ducking** — when two **Channels** overlap, their gain nodes attenuate slightly."
>
> **Dev:** "What happens if a **Model** reaches the **Content boundary** while its **TTS** is still speaking a long **Sentence chunk**?"
>
> **Domain expert:** "The stream is already closed — the LLM finished. But the **Speaking** state continues until that **Sentence chunk** finishes, then the **Channel** goes silent. No new **Sentence chunks** start after the **Content boundary**."

## Flagged ambiguities

- "**thinking**" was used conversationally to mean both the **Thinking** session state and the act of **Reasoning**. In the domain language, **Thinking** is always a session state; **Reasoning** is the model's output. Say "the session is in Thinking state" not "the model is thinking."
- "**model**" without qualification is ambiguous — it could mean **LLM** (Qwen, Nemotron) or **TTS model** (Kokoro). Always disambiguate: say **Model** for LLMs, **TTS model** for speech synthesis.
- "**voice**" was used loosely for both the abstract idea ("giving AI a voice") and the concrete TTS voice preset. Use **Voice** only for the TTS preset. For the abstract idea, say "the model speaks" or "the model's speech."
- "**stream**" was used for both the LLM data flow and the audio playback. In the domain language, **Streaming** is always the LLM token flow. For audio, say "playback" or "the **Channel** is active."
