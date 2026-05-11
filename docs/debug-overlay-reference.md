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
│  ● connected                                 │  ← Connection state
│  🔤 Thinking                                │  ← Pipeline progress
│  ⚡ 180ms · sent: I think...               │  ← TTS latency + last text sent
│  3 queued                                   │  ← Entries waiting
│  ✓ done                                     │  ← Finished
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

### Connection line

Maps to `tts-connect` / `tts-disconnect` events from `KyutaiBackend`.

| Display | Meaning |
|---|---|
| `● connected` | WebSocket to TTS server is open |
| `✗ disconnected` | WebSocket closed or failed |

### Progress line

Maps to `pipeline-progress` events from `ChannelPipeline`.

| Internal Stage | Display | Meaning |
|---|---|---|
| `loaded` | `🚀 Start` | Audio channel created, ready to go |
| `streaming` | `🔤 Thinking` | LLM is streaming reasoning text |
| `finished` | `✅ Done thinking` | LLM finished sending text |
| `done` | `🔇 Finished` | All audio playback complete |

### TTS Latency line

Maps to `tts-first-audio` event from `KyutaiBackend`.

| Display | Meaning |
|---|---|
| `⚡ 180ms` | 180ms from stream open to first sound heard |
| `—` | No first audio received yet |

### Speaking line

Maps to `tts-text-sent` event from `KyutaiBackend`.

| Display | Meaning |
|---|---|
| `sent: I think...` | Last text chunk sent to server for speaking |
| `—` | No text sent yet |

### Queue line

Maps to `tts-queue` event from `KyutaiBackend`.

| Display | Meaning |
|---|---|
| `3 queued` | 3 word entries waiting to be spoken |
| `0 queued` | Server has no backlog — text is keeping up |

### Done line

Maps to `tts-done` event from `KyutaiBackend`. Shows when the speaker has finished.

| Display | Meaning |
|---|---|
| `✓ done` | All text spoken, stream complete |
| `—` | Not finished yet |

### Errors line

Maps to `tts-error` events from `KyutaiBackend` and `pipeline-error` events from `ChannelPipeline`. Shows timestamped error messages (last 5).

```
[12:34:56] Error: connection refused
[12:35:01] Error: TTS synthesis failed
```

Errors are red text, oldest entries are dropped when more than 5 accumulate.

---

## State Flow (Full Lifecycle)

```
Phase        Connection    Progress        Latency    Queue    Done
─────────────────────────────────────────────────────────────────────
Setup        ● connected   🚀 Start         —          —        —
LLM starts   ● connected   🔤 Thinking      —          —        —
Text flowing ● connected   🔤 Thinking      —          3 queued —
First audio  ● connected   🔤 Thinking      ⚡ 180ms   3 queued —
Streaming    ● connected   🔤 Thinking      ⚡ 180ms   5 queued —
LLM done     ● connected   ✅ Done thinking  ⚡ 180ms   1 queued —
All done     ● connected   🔇 Finished      ⚡ 180ms   0 queued ✓ done
```

### Interpretation Tips

- **Healthy stream:** `● connected`, `⚡` under 500ms, `queued` count stable, `sent` text climbing
- **Slow TTS:** `queued` growing — server may be CPU-bound, try `--quantize 8`
- **No audio:** `⚡` stays `—`, `sent` shows nothing — TTS server may be unreachable
- **Stuck:** `queued` at 0 but not `✓ done` — stream may have stalled without closing
- **Capped:** Text stops sending but synthesis continues for already-queued entries

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

### `tts-connect`
Emitted by `KyutaiBackend` when WebSocket connects.

```js
{ modelName: "Qwen" }
```

### `tts-disconnect`
Emitted by `KyutaiBackend` when WebSocket disconnects.

```js
{ modelName: "Qwen" }
```

### `tts-reconnect`
Emitted by `KyutaiBackend` after WebSocket reconnects and resubscribes the
active stream session. Pipeline re-creates the audio stream handle in
response.

```js
{ modelName: "Qwen" }
```

### `tts-first-audio`
Emitted by `KyutaiBackend` when the first PCM frame arrives from the server.

```js
{ modelName: "Qwen", latencyMs: 180 }
```

- `latencyMs` — time from `openStream()` to first PCM chunk received

### `tts-text-sent`
Emitted by `ChannelPipeline` when a text chunk is flushed to the server.

```js
{ modelName: "Qwen", chars: 15, words: 3 }
```

- `chars` — character count of the text chunk
- `words` — approximate word count sent

### `tts-text-dropped`
Emitted by `KyutaiBackend` when `sendText()` or `close()` is called on an
already-closed stream. Text is silently lost; this event makes the loss
observable.

```js
{ modelName: "Qwen", reason: "sendText after stream closed", chars: 12 }
```

- `reason` — why the text was dropped
- `chars` — character count of dropped text (0 for close())

Falls back to `console.warn` when no event bus is configured.

### `tts-queue`
Emitted by `KyutaiBackend` when the server reports how many entries are queued.

```js
{ modelName: "Qwen", count: 3 }
```

- `count` — number of word entries waiting to be spoken

### `tts-done`
Emitted by `KyutaiBackend` when the server finishes generating all audio.

```js
{ modelName: "Qwen" }
```

### `tts-error`
Emitted by `KyutaiBackend` when the server reports an error, or on
reconnect when a synthesize stream has no text to resubmit.

```js
{ modelName: "Qwen", message: "invalid voice" }
```

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
