# Issue #2 — Single-Model LLM streaming to text
## Blocker: #1

Implement GitHub issue #2 for repo nekobuff69/thinking-out-loud.

Fetch the issue with `gh issue view 2 --comments` to read the full spec.

Context: #1 set up the project skeleton with config.js, index.html dark theme, and directory structure. config.js has a models[] array (use only models[0] for now). Read UBIQUITOUS_LANGUAGE.md — use terms precisely: Reasoning (not "thinking"), Content boundary, Column, etc.

Goal: Wire up one Model end-to-end from prompt to streaming text. Build StreamParser (SSE → onReasoningToken/onContentStart callbacks), LM Studio client (fetch with stream:true), PromptSelector UI (5 curated prompts + free text + Ask button), and a Column rendering monospaced streaming text with auto-scroll and "new content below" indicator. No TTS, no audio, no multi-model yet.
