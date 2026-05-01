Status: needs-triage

# 01 — Scaffold and configuration

## Parent

[Thinking Out Loud PRD](../PRD.md)

## What to build

Set up the project skeleton: directory structure, configuration module, HTML shell with dark theater theme, and stub module files. Remove ComfyUI legacy files. The page loads and displays the dark layout with placeholder columns.

End-to-end: open `index.html` in a browser → see dark background with three empty Column placeholders and a PromptSelector area.

## Acceptance criteria

- [ ] Project directory structure created: `llm/`, `tts/`, `audio/`, `ui/`, `session/`
- [ ] `config.js` exports the full configuration object: `defaultMode`, `curatedPrompts` (5 prompts), `models[]` (3 entries with name/provider/url/model/voice/color/pan), `tts{}` (model selector, maxTokens, sentenceTimeoutTokens), `systemPrompt`, `maxHistorySessions`
- [ ] `index.html` rewritten: dark theater theme (black background), imports `index.js` as type module, no ComfyUI references
- [ ] `index.js` created as main entry point, imports config and renders stub UI
- [ ] ComfyUI files removed: `triggerWorkflow.js`, `workflowTemplate.js`, `getWorkflowWithRandomSeed.js`
- [ ] `legacy-test-run-data/` directory confirmed (was `data/`)
- [ ] Reference files kept: `getReasoningContent.js`, `saveReasoning.js`, `normalizeModelName.js`
- [ ] `AGENTS.md` and `docs/agents/` remain intact

## Blocked by

None — can start immediately.
