# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — module map, data flow, key interfaces
- **`UBIQUITOUS_LANGUAGE.md`** at the repo root — domain glossary, term definitions
- **`docs/adr/`** — read ADRs that touch the area you're about to work in

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── UBIQUITOUS_LANGUAGE.md
├── README.md
├── index.html
├── index.js
├── config.js
├── docs/adr/
│   └── 001-deepen-module-architecture.md
├── ui/          (prompt-selector, column, history + CSS)
├── session/     (orchestrator, channel-pipeline, storage + adapters)
├── tts/         (kyutai-backend, tts-engine, text-chunker)
├── audio/       (audio-graph, waveform)
├── llm/         (llm-stream, health-check)
├── styles/      (global.css, top-bar.css)
└── test/        (15 suites, 64 tests)
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
