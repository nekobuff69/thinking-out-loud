# Thinking Out Loud

Ask questions and hear multiple LLMs reason out loud, with TTS voice synthesis.

## Development

```bash
# Start Vite dev server
npm run dev

# Production build
npm run build

# Preview production build locally
npm run preview

# Type-check JavaScript with TypeScript
npm run typecheck
```

## Project Structure

- `index.html` — Root HTML (no inline styles)
- `index.js` — App bootstrap
- `ui/` — UI components (prompt selector, mode toggle, columns, history)
- `styles/` — Global and top-bar CSS
- `audio/` — Audio graph and waveform visualization
- `tts/` — Text-to-speech engine (Kokoro backend)
- `llm/` — LLM streaming and health checks
- `session/` — Orchestrator, storage, and channel pipelines
