Status: needs-triage

# 02 — Single-Model LLM streaming to text

## Parent

[Thinking Out Loud PRD](../PRD.md)

## What to build

Wire up one Model end-to-end: user selects or types a Question → LM Studio streaming chat completion → StreamParser extracts Reasoning tokens → Column renders streaming text. No TTS, no audio, no multi-model yet.

End-to-end: open page → click a curated prompt → hit Ask → one Column streams reasoning text in monospace, auto-scrolling. User can manually scroll up and see a "new content below" indicator when tokens continue arriving. When the Model reaches the Content boundary, streaming stops (final answer never displayed).

## Acceptance criteria

- [ ] `llm/stream-parser.js` consumes a ReadableStream, parses SSE chunks, fires `onReasoningToken` and `onContentStart` callbacks
- [ ] `llm/lm-studio-client.js` sends a streaming chat completion request to the Model's URL with `stream: true`, returns the response stream
- [ ] PromptSelector UI renders 5 curated prompts as clickable cards and a free-text input field with Ask button
- [ ] Clicking a curated prompt or typing free text + Ask starts a Session for one Model (from config)
- [ ] Column renders the Model's Display name and a monospaced text container
- [ ] Reasoning text streams in as tokens arrive (raw append, no animation)
- [ ] Column auto-scrolls to the latest text, with manual scroll-back support
- [ ] When scrolled up and new tokens arrive, a subtle indicator appears at the bottom
- [ ] When the Content boundary is hit (`onContentStart` fires), streaming stops and the Final answer is discarded
- [ ] The Column shows the Model's assigned Color for its text

## Blocked by

- `01-scaffold-and-config` — requires config.js and index.html shell
