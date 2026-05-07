## Agent skills

### Quick validation

Before claiming work is done, run:

```bash
npm test          # Node built-in test runner (15 tests, 5 suites)
npm run typecheck # TypeScript strict check-js (tsc --noEmit)
npm run build     # Vite production build
```

### Issue tracker

GitHub — issues live in the repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `UBIQUITOUS_LANGUAGE.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
