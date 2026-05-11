## Agent skills

### Quick validation

Before claiming work is done, run:

```bash
npm test              # Node built-in test runner (104 tests, 17 suites)
npm run typecheck     # TypeScript strict check-js (tsc --noEmit)
npm run build         # Vite production build
python3 -c "import py_compile; py_compile.compile('server/tts-server-streaming.py', doraise=True)"  # Python server syntax check
python3 -c "import py_compile; py_compile.compile('server/test_server_streaming.py', doraise=True)"  # Python test syntax check
```

### Issue tracker

GitHub — issues live in the repo's GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `UBIQUITOUS_LANGUAGE.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
