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
│  🔤 Thinking                                │  ← Pipeline progress
│  ⚡ TTS: 0.42s · Audio: 15 chunk(s) 12 kB  │  ← TTS latency + audio stats
│  [12:34:56] Error: connection refused       │  ← Errors
│──────────────────────────────────────────────────│
│  Gemma                                       │  ← Second model card
│  ...                                        │
└──────────────────────────────────────────────────┘
```

Panel floats in the top-right corner, monospace dark theme, 380px wide.

---

## Global Bar

Shows the overall session state and per-model token counts.

```
Session: Thinking · Qwen 45 tokens, Gemma 32 tokens, OSS 18 tokens
```

| Component | Source |
|---|---|
| `Session: {state}` | `orchestrator.state` — one of: `Idle`, `Loading`, `Checking`, `Thinking`, `Speaking`, `Finished` |
| `{name} {count} tokens` | Cumulative token count from `event-bus.on("token")` events per model |

---

## Per-model Card

Each model gets its own card showing pipeline internals.

### Progress line

Maps to `pipeline-progress` events from `ChannelPipeline`.

| Internal Stage | Display | Meaning |
|---|---|---|
| `loaded` | `🚀 Start` | Audio channel created, ready to go |
| `streaming` | `🔤 Thinking` | LLM is streaming reasoning text |
| `finished` | `✅ Done thinking` | LLM finished sending text |
| `done` | `🔇 Finished` | All audio playback complete |

### TTS Latency line

Maps to `tts-first-chunk` event from `KyutaiBackend`.

| Display | Meaning |
|---|---|
| `⚡ TTS: 0.42s` | 420ms from first token sent to server until first PCM chunk received |
| `—` | No first chunk received yet |

### Audio line

Maps to `tts-chunk` events from `KyutaiBackend`. Cumulative chunk count and bytes.

| Display | Meaning |
|---|---|
| `Audio: 15 chunk(s) 12 kB` | 15 PCM chunks received, ~12KB total audio data |
| `—` | No audio chunks received yet |

### Errors line

Maps to `pipeline-error` events from `ChannelPipeline`. Shows timestamped error messages (last 5).

```
[12:34:56] Error: connection refused
[12:35:01] Error: TTS synthesis failed
```

Errors are red text, oldest entries are dropped when more than 5 accumulate.

---

## State Flow (Full Lifecycle)

```
Phase        Progress         TTS Latency     Audio
───────────────────────────────────────────────────────────
Setup        🚀 Start         —               —
LLM starts   🔤 Thinking      —               —
Text flowing 🔤 Thinking      —               —
First audio  🔤 Thinking      ⚡ TTS: 0.42s   Audio: 1 chunk(s) 2 kB
Streaming    🔤 Thinking      ⚡ TTS: 0.42s   Audio: 15 chunk(s) 12 kB
LLM done     ✅ Done thinking  ⚡ TTS: 0.42s   Audio: 45 chunk(s) 36 kB
All done     🔇 Finished      ⚡ TTS: 0.42s   Audio: 45 chunk(s) 36 kB
```

### Interpretation Tips

- **Healthy stream:** `TTS Latency` is sub-second, `Audio` chunk count is climbing
- **Slow TTS:** `TTS Latency` > 2s — server may be CPU-bound, try `--quantize 8`
- **No audio:** `TTS Latency` stays `—` — TTS server may be unreachable
- **Capped:** Text stops streaming but synthesis continues for remaining audio

---

## Keyboard Shortcut

| Key | Action |
|---|---|
| `` ` `` (backtick) | Toggle debug overlay |
| `Ctrl+Shift+D` | Toggle debug overlay |

The panel is also enabled automatically when the URL has `?debug` query parameter.

---

## Event Bus Reference

All data flows through `SimpleEventBus` events.

### `token`
Emitted by `ChannelPipeline.feedToken()` for every LLM token.

```js
{ modelName: "Qwen", token: "the" }
```

### `tts-first-chunk`
Emitted by `KyutaiBackend` when the first PCM frame arrives from the server.

```js
{ modelName: "Qwen", latencyMs: 420 }
```

- `latencyMs` — time from `startStream()` call to first PCM chunk received

### `tts-chunk`
Emitted by `KyutaiBackend` for each PCM frame received.

```js
{ modelName: "Qwen", bytesReceived: 2048 }
```

- `bytesReceived` — raw byte count of the Float32Array PCM data

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
