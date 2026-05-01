# Issue #1 — Scaffold and config
## Blocker: none — run first

Implement GitHub issue #1 for repo nekobuff69/thinking-out-loud.

Fetch the issue with `gh issue view 1 --comments` to read the full spec.

Context: This is a browser-only app with no build step using vanilla JS ES modules. The project already has an index.html, package.json (with @huggingface/transformers and dotenv), and legacy files. Read AGENTS.md and UBIQUITOUS_LANGUAGE.md for domain vocabulary.

Goal: Set up the project skeleton. Create directory structure (llm/, tts/, audio/, ui/, session/), write config.js with the full configuration object, rewrite index.html with dark theater theme, and remove ComfyUI legacy files. Keep getReasoningContent.js, saveReasoning.js, normalizeModelName.js as reference.
