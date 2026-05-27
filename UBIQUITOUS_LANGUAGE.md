# Ubiquitous Language

## Session lifecycle

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Session** | A single round-trip: one question asked, three LLMs respond with reasoning, audio plays, results are saved | Run, cycle, generation |
| **Question** | The text the user asks — either a curated prompt or free-text input | Query, prompt, input |
| **Curated prompt** | One of five pre-written philosophical questions that frame the artistic theme | Preset, starter, suggested question |
| **Free-text question** | A user-typed question not from the curated list | Custom prompt, typed input |
| **Ask** | The user action that starts a session (clicking the Ask button) | Submit, go, start, run |
| **Loading** | Session state: TTS server connection via HTTP health check (shows spinner) | Warm-up, setup, preparing |
| **Checking** | Session state: LLM provider health pings (/models). Follows Loading, precedes Thinking. | Probing, pinging, verifying |
| **Thinking** | Session state: LLM reasoning streams are active and TTS is playing | Streaming, generating, running |
| **Speaking** | Session state: LLM streams have ended but TTS audio is still playing | Tail, finishing, trailing |
| **Done** | Session state: all playback complete, session saved, replay available | Finished, complete, ended |
| **Stop** | User action that soft-stops all pipelines, transitions through Done to Idle. Session can immediately start again. | Cancel, abort, kill, mute |
| **Soft stop** | Immediate kill: close all TTS streams, kill connections, stop audio. Returns app to fresh idle state. | Hard kill, immediate stop |
| **Replay** | Re-synthesize TTS audio from a past session's stored reasoning text using the legacy single-shot synthesiz protocol | Playback, listen again, re-listen |
| **History** | The list of past saved sessions browsable for replay | Archive, past sessions, log |

## LLM domain

| Term | Definition | Aliases to avoid |
|---|---|---|
| **LLM** | A large language model running locally that receives a question and produces reasoning | AI, bot, agent, mind |
| **Model** | A specific LLM identified by architecture and weights (e.g. Qwen, Gemma, GPT-OSS) | LLM instance, engine, brain |
| **Provider** | The local inference server that hosts and runs models (e.g. LM Studio) | Server, backend, inference engine, runtime |
| **Reasoning** | The LLM's internal thought process — the `reasoning_content` field in the API response | Thinking, chain of thought, internal monologue, reasoning block |
| **Reasoning format** | How the provider separates reasoning from final answer: `separate` (dedicated field), `tagged` (`<think>` tags), or `none` (no separation) | Format mode, parsing mode |
| **Reasoning content** | The raw text of the LLM's reasoning, streamed token by token | Thinking block, thought stream, reasoning stream |
| **Final answer** | The LLM's polished output — the `content` field in the API response. Deliberately suppressed. | Response, output, answer, completion |
| **Content boundary** | The point in the stream where the LLM transitions from reasoning to final answer | Cut point, answer start, switch |
| **Streaming** | Receiving LLM output token-by-token via SSE as it is generated | Live, real-time, chunked |
| **Token** | A single unit of text from the LLM stream (sub-word or punctuation) | Piece, fragment, chunk (when referring to text, not audio) |
| **Token cap** | The maximum number of reasoning words (~200) that are synthesized to speech. Text continues accumulating for storage. | Speech limit, TTS cutoff, word budget |
| **System prompt** | The instruction given to all models before the question (e.g. "You are a critical thinker") | System message, preamble, context |

## TTS and audio domain

| Term | Definition | Aliases to avoid |
|---|---|---|
| **TTS** | Text-to-speech: the browser-side synthesis that converts reasoning text into spoken audio | Speech synthesis, voice synthesis, audio generation |
| **TTS model** | The speech synthesis model: Pocket TTS (100M params, CPU-only, HTTP server). See `docs/tts-technology-evaluation.md`. | Speech engine, voice model, synthesis backend |
| **TTS protocol** | HTTP request/response contract between browser and TTS server: `POST /v1/tts` with `{text, voice}` → streaming WAV audio. Legacy synthesize replay path preserved via same endpoint. | Wire format, message schema |
| **Stream handle** | PocketTtsBackend handles text as complete sentences via `startStream()`. No incremental `sendText`/`close` pattern. | Stream object, TTS handle |
| **Unsent buffer** | Accumulator in the ChannelPipeline for the replay (`drainText`) path. Live path uses sentence queue via `TextChunker`. | Pending text, text accumulator |
| **Voice** | A distinct speaker identity assigned to one model. Resolved from a raw WAV sample or pre-exported `.safetensors` voice state via `get_state_for_audio_prompt()`. | Speaker, persona, voice preset, timbre, voice sample |
| **Speaker embedding** | A mathematical representation of a speaker's voice characteristics. FlowLM KV cache state derived from Mimi-encoded audio, exportable as `.safetensors`. | Voice embedding, voiceprint, conditioning vector |
| **Voice cloning** | Creating a Voice from a raw audio sample (WAV, MP3). Native in Pocket TTS via `get_state_for_audio_prompt()` — encodes audio through Mimi → FlowLM speaker projection → voice state ready for generation. DSM voice cloning requires a gated model not publicly released (see `docs/tts-technology-evaluation.md`). | Voice creation, voice extraction, speaker enrollment |
| **PCM chunk** | A single Float32Array audio frame received from Pocket TTS server via HTTP streaming response, played continuously through the AudioContext | Audio frame, PCM buffer, audio segment |
| **Text chunker** | Word accumulator that flushes on configurable punctuation (`.!?;,`), max words (15), or silence timeout (2000ms, min 3 words). Feeds complete sentences/clauses to TTS. | Word accumulator, chunk accumulator |
| **First-audio latency** | Time from first reasoning token arriving to first PCM chunk playing — typically sub-200ms with incremental text feeding | Time-to-first-chunk, TTS startup delay |
| **AudioContext** | The browser's Web Audio API context managing all audio routing and playback | Audio graph, audio engine, sound system |
| **Channel** | A per-model audio pipeline: gain node → stereo panner → AnalyserNode → output. Supports two playback modes: `playStream()` (replay) and `openStream()` (live). | Audio lane, voice lane, audio strip |
| **Panning** | Stereo spatial positioning of a channel (left, center, right) | Spatial audio, stereo position, placement |
| **Ducking** | Subtle volume reduction on all channels when multiple voices overlap | Volume attenuation, gain reduction |
| **AnalyserNode** | The Web Audio API node that extracts real-time frequency/amplitude data for waveform rendering | Audio analyser, FFT node |

## Playback

| Term | Definition | Aliases to avoid |
|---|---|---|
|| **Sequential playback** | TTS voices speak one at a time, in random order per session. All three LLMs reason simultaneously (text visible), only TTS is sequential. | Serial, one-at-a-time, monologue |

## Visual domain

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Column** | A vertical panel in the UI representing one model — contains display name, reasoning text, and waveform | Pane, panel, slot, lane |
| **Waveform** | A live canvas visualization of a channel's AnalyserNode data, rendered in the model's color | Audio viz, sound wave, oscilloscope, bars |
| **Idle waveform** | The gentle breathing/pulsing animation shown when a channel is silent | Standby animation, resting waveform, idle pulse |
| **Display name** | The human-readable name for a model shown in the UI (e.g. "Qwen", not "qwen_qwen3-30b") | Label, title, heading |
| **Color** | The distinguishing hex color assigned to a model, applied to text and waveform | Hue, tint, theme color |
| **Dark theater** | The visual theme: black background, colored text, glowing waveforms | Dark mode, cinematic theme, stage |
| **Debug overlay** | A togglable panel (backtick or Ctrl+Shift+D shortcut) showing real-time pipeline state, per-model token counts, TTS latency (time-to-first-chunk), audio chunk delivery, and error logs | Diagnostics panel, dev tools, status panel |
| **Event bus** | A lightweight observer pattern allowing pipeline modules to emit state events without knowing about consumers (e.g. the debug overlay) | Message bus, pub-sub, event stream |
| **Loading spinner** | CSS-animated ring shown during the Loading state, hidden when session enters Checking. Provides visual feedback during TTS server connection. | Loader, progress indicator |

## Persistence

| Term | Definition | Aliases to avoid |
|---|---|---|
| **Session store** | LocalStorage-based storage for past session data (question + per-model reasoning text + metadata) | History store, session database |
| **Eviction** | Removing the oldest session when the max history limit is exceeded | Pruning, cleanup, rotation |
| **Recent questions** | Free-text questions temporarily saved in LocalStorage for quick reuse | Question history, past prompts |

## Relationships

- A **Session** is started by an **Ask** action with one **Question**
- A **Session** queries three **Models**, each served by a **Provider**
- Each **Model** produces one stream of **Reasoning** and one **Final answer**
- The **Final answer** is detected at the **Content boundary** and never spoken or displayed
- All three **Models** reason simultaneously (text displayed in all columns). TTS plays sequentially in random order per session. Only one pipeline feeds TTS at a time.
- **Reasoning** tokens accumulate in active pipeline's **Unsent buffer**, then flush as complete sentences via **Text chunker** to the **TTS server** via HTTP
- The **TTS server** receives complete text via `POST /v1/tts` and streams **PCM chunks** using the model's assigned **Voice**
- Each **Model** has its own HTTP-based TTS pipeline (sequential playback, one active at a time)
- Each **Model** has one **Channel** in the **AudioContext**, with its own **Panning** position. The channel uses `openStream()` mode for live playback and `playStream()` mode for replay.
- Each **Channel** has one **AnalyserNode** that drives the **Waveform** in that model's **Column**
- A **Column** shows the **Display name**, streaming reasoning text, and **Waveform** in the model's **Color**
- **TTS** stops when the **Token cap** is reached (current audio finishes, no new text sent)
- A **Stop** action triggers a **Soft stop**: abort streams and stop TTS immediately
- A **Replay** loads a past **Session** from the **Session store** and re-synthesizes audio from stored **Reasoning**
- The **Session store** applies **Eviction** when stored **Sessions** exceed the configured maximum

## Example dialogue

> **Dev:** "When the user hits **Ask**, do I start all three **Channels** at once?"
>
> **Domain expert:** "Yes — fire all three LLM fetches simultaneously. Each **Model** starts its **Reasoning** stream independently. The reasoning text appears in all three columns at once. TTS plays sequentially but the voice order is randomized per session: the first pipeline in shuffled order speaks, while the others accumulate text silently. When that pipeline finishes, the next in shuffled order resumes and sends its full reasoning to TTS, then the last."
>
> **Dev:** "And the **TTS model** — does it queue text per **Channel**, or synthesize in some global order?"
>
> **Domain expert:** "Per **Channel**. Each **Channel** makes its own HTTP request to the TTS server. At any moment, only one pipeline is active — the others are idle. When a pipeline resumes, it sends its full accumulated text as a single POST. The server generates audio and streams back WAV chunks. **Ducking** is still present for any brief overlap when one voice's tail overlaps with the next voice's start."
>
> **Dev:** "What happens if a **Model** reaches the **Content boundary** while its **TTS** is still generating audio?"
>
> **Domain expert:** "The LLM stream is closed. The server finishes generating the remaining audio for the text already sent, then the **Channel** goes silent. No new text is sent after the **Content boundary**."

## Flagged ambiguities

- "**thinking**" was used conversationally to mean both the **Thinking** session state and the act of **Reasoning**. In the domain language, **Thinking** is always a session state; **Reasoning** is the model's output. Say "the session is in Thinking state" not "the model is thinking."
- "**model**" without qualification is ambiguous — it could mean **LLM** (Qwen, Gemma) or **TTS model** (Pocket TTS). Always disambiguate: say **Model** for LLMs, **TTS model** for speech synthesis.
- "**voice**" was used loosely for both the abstract idea ("giving AI a voice") and the concrete TTS voice preset. Use **Voice** only for the TTS preset. For the abstract idea, say "the model speaks" or "the model's speech." Also ambiguous: a **Voice** may refer to the config value (an embedding name like `alba-mackenna/casual.wav`), the underlying **Speaker embedding** (a `.safetensors` file), or a raw audio sample used for **Voice cloning**. Disambiguate: use **Voice** for the identity, **Speaker embedding** for the data file, **Voice cloning** for the creation process.
- "**stream**" was used for both the LLM data flow and the audio playback. In the domain language, **Streaming** is always the LLM token flow. For audio, say "playback" or "the **Channel** is active." A **TTS stream** (via **Stream handle**) is the active synthesis session between one pipeline and the server.
