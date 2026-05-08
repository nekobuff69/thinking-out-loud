# Debug Overlay Reference

Interactive diagnostics panel for the Thinking Out Loud app. Press `` ` `` or `Ctrl+Shift+D` to toggle.

## Layout

```
┌──────────────────────────────────────────────────┐
│  🔧 Debug Overlay                               │
│──────────────────────────────────────────────────│
│  Session: Thinking · Qwen 45 tokens           │  ← Global bar (green)
│──────────────────────────────────────────────────│
│  Qwen                                        │  ← Model card
│  📖 11 words · ⚠️ Max                     │  ← Buffer line
│  🎙️ Generating voice · 2 waiting          │  ← Queue line
│  ⏱️ 0.85 s                                │  ← Synth line
│  [12:34:56] Error: connection refused       │  ← Errors
│──────────────────────────────────────────────────│
│  Gemma                                       │  ← Second model card
│  ...                                        │
└──────────────────────────────────────────────────┘
```

Panel floats in the top-right corner, monospace dark theme, 380px wide.

---

## Global Bar

Shows the overall session state and per-model token counts. No token-per-second rates (they fluctuate too much to be meaningful).

```
Session: Thinking · Qwen 45 tokens, Gemma 32 tokens, OSS 18 tokens
```

| Component | Source |
|---|---|
| `Session: {state}` | `orchestrator.state` — one of: `Idle`, `Loading`, `Checking`, `Thinking`, `Speaking`, `Finished` |
| `{name} {count} tokens` | Cumulative token count from `event-bus.on("token")` events per model |

When no tokens have arrived:
```
Session: Idle
```

When multiple models have emitted tokens:
```
Session: Thinking · Qwen 120 tokens, Gemma 95 tokens, OSS 44 tokens
```

---

## Per-model Card

Each model gets its own card showing pipeline internals from the LLM stream through TTS playback.

### Progress line

Maps to `pipeline-progress` events from `ChannelPipeline`. Describes what the model is doing from a user perspective.

| Internal Stage | Display | Meaning |
|---|---|---|
| `loaded` | `🚀 Start` | Audio channel created, ready to go |
| `streaming` | `🔤 Thinking` | LLM is streaming reasoning text |
| `finished` | `✅ Done thinking` | LLM finished sending text |
| `done` | `🔇 Finished` | All text spoken, TTS queue empty |

Example card lifecycle for a single model:
```
🚀 Start
🔤 Thinking
🔤 Thinking        ← stream continues
✅ Done thinking   ← LLM stream ended
🔇 Finished       ← TTS finished playing
```

### Buffer line

Maps to `buffer-state` events from `SentenceBuffer`. Shows words accumulated in the text buffer before TTS. The buffer bundles two sentences at a time to amortize TTS synthesis overhead.

| Display | Meaning |
|---|---|
| `—` | Nothing buffered (initial state or just flushed) |
| `11 words` | 11 words accumulated in the buffer |
| `11 words · ⚠️ Max` | Same, but token cap reached — model hit its limit |

Fields mapping:
- `wordCount` — human-readable word count (shown)
- `tokenCount` — raw token count (not shown separately; implied by word count)
- `sentencesHeld` — sentences held back by the two-sentence bundler (not shown; already implied by word count)
- `capped` — whether the max token limit was hit (shown as `· ⚠️ Max`)

The `—` is shown when `tokenCount === 0` and `wordCount === 0`.

### Queue line

Maps to `queue-state` events from `TTSPlaybackQueue`. Shows the TTS playback state machine with 6 states. Pre-synthesis means the next sentence is synthesized *while* the current one plays, for gap-free audio.

| Internal State | Display | Meaning |
|---|---|---|
| `Idle` | `Idle` | Queue empty, no work pending |
| `Synthesizing` | `🎙️ Generating voice` | TTS engine computing audio (you're waiting) |
| `Playing` | `🔊 Speaking` | Audio flowing through speakers |
| `Gapping` | `⏸ Pausing` | Brief 50ms gap between sentences |
| `Paused` | `⏸ Paused` | Manually paused (Monologue mode) |
| `Stopped` | `⏹ Stopped` | Soft stop in progress |

Depth (how many items queued ahead):
- Shown as `· N waiting` appended to the state label
- Omitted when depth is 0 (nothing waiting)
- `depth` = `queue.length + (nextBuffer ? 1 : 0)` — count of sentences in the queue plus the pre-synthesized buffer

Examples:
```
Idle                          ← empty queue, nothing happening
🎙️ Generating voice         ← computing first sentence audio
🔊 Speaking                  ← playing, no queue ahead
🔊 Speaking · 2 waiting     ← playing, 2 more sentences queued
⏸ Pausing · 1 waiting      ← gap between sentences, 1 synthesized ahead
⏹ Stopped                  ← soft stop requested
```

### Synth line

Maps to `synth-timing` events from `TTSPlaybackQueue`. Shows the time taken to synthesize the most recent sentence.

| Display | Meaning |
|---|---|
| `⏱️ 0.85 s` | 850ms to synthesize the last sentence |
| `⏱️ 1.20 s` | 1200ms to synthesize |

Source: `timingMs` from the event, converted to seconds with 2 decimal places.

### Errors line

Maps to `pipeline-error` events from `ChannelPipeline`. Shows timestamped error messages (last 5).

```
[12:34:56] Error: connection refused
[12:35:01] Error: TTS synthesis failed
```

Errors are red text, oldest entries are dropped when more than 5 accumulate.

---

## State Flow (Full Lifecycle)

Here's how a card looks through a complete thinking session:

```
Phase        Progress          Buffer              Queue                   Synth
─────────────────────────────────────────────────────────────────────────────────
Setup        🚀 Start          —                   Idle                    
LLM starts   🔤 Thinking       —                   Idle                    
Text flowing 🔤 Thinking      11 words            🎙️ Generating voice     ⏱️ 0.30 s
Audio starts 🔤 Thinking      23 words            🔊 Speaking             ⏱️ 0.42 s
Queued       🔤 Thinking      35 words            🔊 Speaking · 3 waiting  ⏱️ 0.35 s
LLM done     ✅ Done thinking  45 words            🔊 Speaking · 1 waiting  ⏱️ 0.28 s
All done     🔇 Finished      45 words            Idle                    
Completed    🔇 Finished      —                   Idle                    
```

### Interpretation Tips

- **Healthy stream:** `Buffer` shows growing word count, `Queue` says `Speaking · N waiting`, `Synth` is consistent
- **Slow TTS:** `Synth` ms climbing, `Queue` stuck on `Generating voice` for a long time
- **Backlog:** `Queue` says `Speaking · 5+ waiting` — synthesis can't keep up with text
- **Model capped:** `Buffer` shows `· ⚠️ Max` — model hit its token limit
- **Done:** `Progress` says `🔇 Finished`, `Queue` says `Idle`, `Buffer` says `—`

---

## Keyboard Shortcut

| Key | Action |
|---|---|
| `` ` `` (backtick) | Toggle debug overlay |
| `Ctrl+Shift+D` | Toggle debug overlay |

The panel is also enabled automatically when the URL has `?debug` query parameter.

---

## Event Bus Reference

All data flows through `SimpleEventBus` events. Here's the complete event map:

### `token`
Emitted by `ChannelPipeline.feedToken()` for every LLM token.

```js
{ modelName: "Qwen", token: "the" }
```

- Consumed by DebugOverlay for the global token count
- Consumed by SentenceBuffer for text accumulation

### `buffer-state`
Emitted by `SentenceBuffer` on every sentence boundary detection, timeout flush, or token cap.

```js
{ modelName: "Qwen", tokenCount: 45, wordCount: 11, sentencesHeld: 2, capped: false }
```

- `tokenCount` — total tokens in the buffer (flushed + pending + current)
- `wordCount` — human-readable word count (split by whitespace)
- `sentencesHeld` — number of completed sentences waiting in the two-sentence bundler
- `capped` — true if the max token cap was reached

### `queue-state`
Emitted by `TTSPlaybackQueue` on every state change.

```js
{ modelName: "Qwen", depth: 2, state: "Playing" }
```

- `depth` — total items in queue (`pending.length + (nextBuffer ? 1 : 0)`)
- `state` — one of: `Idle`, `Synthesizing`, `Playing`, `Gapping`, `Paused`, `Stopped`

### `synth-timing`
Emitted by `TTSPlaybackQueue` after each successful synthesis.

```js
{ modelName: "Qwen", timingMs: 850 }
```

- `timingMs` — time in milliseconds from synthesis start to audio buffer ready

### `pipeline-progress`
Emitted by `ChannelPipeline` on lifecycle stage changes.

```js
{ modelName: "Qwen", stage: "streaming" }
```

- `stage` — one of: `loaded`, `streaming`, `finished`, `done`

### `pipeline-error`
Emitted by `ChannelPipeline` when an error occurs.

```js
{ modelName: "Qwen", message: "connection refused", timestamp: 1715234567890 }
```

- `message` — human-readable error description
- `timestamp` — Unix timestamp in milliseconds
