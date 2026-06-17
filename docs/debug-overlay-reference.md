# Debug Overlay Reference

Interactive diagnostics panel for the Thinking Out Loud app. Press `` ` `` or `Ctrl+Shift+D` to toggle.

## Layout

```
┌──────────────────────────────────────────────────┐
│  🔧 Debug Overlay                               │
│──────────────────────────────────────────────────│
│  Session: Thinking · Qwen 45 tokens           │  ← Global bar
│──────────────────────────────────────────────────│
│  Qwen                                        │  ← Model card
│  Status: —                                    │  ← Connection state (placeholder)
│  Progress: 🔤 Thinking                       │  ← Pipeline progress
│  TTS Latency: —                               │  ← Latency (placeholder)
│  Audio: —                                     │  ← Chunk count / bytes (placeholder)
│  Text sent: —                                 │  ← Last text sent (placeholder)
│  [12:34:56] Error: connection refused         │  ← Errors
│──────────────────────────────────────────────────│
│  Gemma                                       │  ← Second model card
│  ...                                        │
└──────────────────────────────────────────────────┘
```

Panel floats in the top-right corner, monospace dark theme, 380px wide.

---

## Global Bar

Shows the overall session state and per-model token counts. Updated every 250ms via interval.

```
Session: Thinking · Qwen 45 tokens, Gemma 32 tokens, OSS 18 tokens
```

| Component | Source |
|---|---|
| `Session: {state}` | `orchestrator.state` — one of: `Idle`, `Loading`, `Checking`, `Thinking`, `Speaking`, `Done`, `Error: ...` |
| `{name} {count} tokens` | Cumulative token count from `event-bus.on("token")` events per model (`ChannelPipeline.feedToken()`) |

---

## Per-model Card

Each model gets its own card showing pipeline internals.

### Status line

| Display | Meaning |
|---|---|
| `—` | No connection event received (default) |
| `connected` | `tts-connect` event received (wired for future TTS instrumentation) |
| `disconnected` | `tts-disconnect` event received |
| `done` | `tts-done` event received |

### Progress line

Maps to `pipeline-progress` events from `ChannelPipeline`.

| Internal Stage | Display | Meaning |
|---|---|---|
| `loaded` | 🚀 Start | Audio channel created, ready to go |
| `streaming` | 🔤 Thinking | LLM is streaming reasoning text |
| `finished` | ✅ Done thinking | LLM finished sending text |
| `done` | 🔇 Finished | All audio playback complete |

### TTS Latency line

Maps to `tts-first-chunk` event (wired for future TTS instrumentation).

| Display | Meaning |
|---|---|
| `⏱ 180ms` | 180ms from stream open to first sound heard |
| `—` | No first audio received yet (never fires with current PocketTtsBackend) |

### Audio line

Maps to `tts-chunk` event (wired for future TTS instrumentation).

| Display | Meaning |
|---|---|
| `3 chunks · 45.2kB` | Chunk count and total bytes received |
| `—` | No audio chunks received yet |

### Text sent line

Maps to `tts-text-sent` event (wired for future TTS instrumentation).

| Display | Meaning |
|---|---|
| `15 chars` | Character count of last text sent |
| `—` | No text sent yet |

### Errors line

Maps to `pipeline-error` events from `ChannelPipeline.setError()`. Shows timestamped error messages (last 5).

```
[12:34:56] Error: connection refused
[12:35:01] Error: TTS synthesis failed
```

Errors are red text, oldest entries are dropped when more than 5 accumulate.

---

## State Flow (Full Lifecycle — Currently Wired)

```
Phase        Progress         Token events    Errors
─────────────────────────────────────────────────────
Setup        🚀 Start         —                —
LLM starts   🔤 Thinking      tokens flowing   —
LLM done     ✅ Done thinking  tokens stop      —
TTS done     🔇 Finished      —                —
Error        (any)            —                [timestamped]
```

TTS-specific diagnostics (latency, chunks, queue depth, connection status) are
wired at the subscription level but require backend instrumentation that the
current `PocketTtsBackend` does not emit — they show placeholder `—` values.

---

## Keyboard Shortcut

| Key | Action |
|---|---|
| `` ` `` (backtick) | Toggle debug overlay |
| `Ctrl+Shift+D` | Toggle debug overlay |

The panel is also enabled automatically when the URL has `?debug` query parameter.

---

## Event Bus Reference

Only these events are currently emitted by the codebase. The overlay subscribes
to additional TTS events (listed as "wired but not emitted") that will fire when
backend instrumentation is added.

### Actually emitted

#### `token`
Emitted by `ChannelPipeline.feedToken()` for every LLM token.

```js
{ modelName: "Qwen", token: "the" }
```

#### `pipeline-progress`
Emitted by `ChannelPipeline` on lifecycle stage changes.

```js
{ modelName: "Qwen", stage: "streaming" }
```

- `stage` — one of: `loaded`, `streaming`, `finished`, `done`

#### `pipeline-error`
Emitted by `ChannelPipeline` when an error occurs.

```js
{ modelName: "Qwen", message: "connection refused", timestamp: 1715234567890 }
```

- `message` — human-readable error description
- `timestamp` — Unix timestamp in milliseconds

### Wired but not yet emitted (awaiting PocketTtsBackend instrumentation)

These events are subscribed by `DebugOverlay` but no module currently emits them.
They show placeholder `—` values in the overlay when no event has fired.

- `tts-connect` → `{ modelName: "Qwen" }`
- `tts-disconnect` → `{ modelName: "Qwen" }`
- `tts-first-chunk` → `{ modelName: "Qwen", latencyMs: 180 }`
- `tts-chunk` → `{ modelName: "Qwen", bytesReceived: 4096 }`
- `tts-done` → `{ modelName: "Qwen" }`
- `tts-text-sent` → `{ modelName: "Qwen", chars: 15, words: 3 }`
