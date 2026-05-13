"""
Pocket TTS HTTP Streaming Server.

A FastAPI server that loads the Pocket TTS model and exposes text-to-speech
via HTTP. Generates streaming WAV audio using generate_audio_stream().

Voice cloning: scans voices/ for .wav files, creates voice states via
get_state_for_audio_prompt(), caches as .safetensors for fast restart.

Usage:
    python server/tts-server-pocket.py --port 8080
    python server/tts-server-pocket.py --voices-dir /path/to/voices
"""
import argparse
import io
import os
import struct
import sys
import time
import traceback

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

SAMPLE_RATE = 24000
CATALOG_VOICES = [
    "cosette", "marius", "javert", "alba", "jean", "anna", "vera",
    "fantine", "charles", "paul", "eponine", "azelma", "george",
    "mary", "jane", "michael", "eve", "bill_boerst", "peter_yearsley",
    "stuart_bell", "caro_davy", "giovanni", "lola", "juergen",
    "rafael", "estelle",
]

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def _ts() -> str:
    return time.strftime("%H:%M:%S", time.localtime())


def log(label: str, msg: str) -> None:
    print(f"[{_ts()}] [{label}] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Voice loading / caching
# ---------------------------------------------------------------------------


def _flatten_state(voice_state: dict) -> dict:
    """Flatten nested {layer: {param: Tensor}} → {layer.param: Tensor}."""
    flat = {}
    for layer_key, params in voice_state.items():
        if isinstance(params, dict):
            for param_key, tensor in params.items():
                flat[f"{layer_key}.{param_key}"] = tensor
        else:
            flat[layer_key] = params
    return flat


def _unflatten_state(flat: dict) -> dict:
    """Reverse of _flatten_state."""
    nested = {}
    for flat_key, tensor in flat.items():
        parts = flat_key.split(".", 1)
        if len(parts) == 2:
            layer_key, param_key = parts
            nested.setdefault(layer_key, {})[param_key] = tensor
        else:
            nested[flat_key] = tensor
    return nested


def _save_safetensors(voice_state, path: str) -> None:
    """Save voice state to .safetensors file. Flattens nested dict."""
    try:
        import safetensors.torch
    except ImportError:
        log("WARN", "safetensors not available, skipping voice state cache")
        return
    try:
        if isinstance(voice_state, dict):
            flat = _flatten_state(voice_state)
            safetensors.torch.save_file(flat, path)
        else:
            safetensors.torch.save_file({"voice_state": voice_state}, path)
    except Exception as exc:
        log("WARN", f"Failed to save voice state to {path}: {exc}")


def _load_safetensors(path: str):
    """Load voice state from .safetensors file. Unflattens if needed."""
    import safetensors.torch
    state = safetensors.torch.load_file(path)
    # Detect if this is a flat-saved voice state (keys contain '.')
    if any("." in k for k in state.keys()):
        return _unflatten_state(state)
    if len(state) == 1 and "voice_state" in state:
        return state["voice_state"]
    return state


def load_voices(tts_model, voices_dir: str) -> dict:
    """Scan *voices_dir* for .wav files and load or regenerate voice states.

    For each .wav found:
      - If a matching .safetensors cache exists and is newer than the .wav,
        load it (fast path).
      - Otherwise call ``get_state_for_audio_prompt(wav_path)`` and export
        the result as .safetensors (slow path).

    Returns a dict mapping voice name → voice state.
    """
    voices: dict = {}

    os.makedirs(voices_dir, exist_ok=True)

    if not os.path.isdir(voices_dir):
        log("WARN", f"Voices directory not found: {voices_dir}")
        return voices

    try:
        for dirpath, _dirnames, filenames in os.walk(voices_dir):
            for fname in sorted(filenames):
                if not fname.lower().endswith(".wav"):
                    continue
                wav_path = os.path.join(dirpath, fname)
                rel_path = os.path.relpath(wav_path, voices_dir)
                voice_name = os.path.splitext(rel_path)[0]

                safetensors_path = os.path.splitext(wav_path)[0] + ".safetensors"

                # --- fast path: cached .safetensors is up-to-date ---
                if (os.path.exists(safetensors_path)
                        and os.path.getmtime(safetensors_path) >= os.path.getmtime(wav_path)):
                    try:
                        voices[voice_name] = _load_safetensors(safetensors_path)
                        log("INIT", f"Loaded voice '{voice_name}' from cache")
                        continue
                    except Exception as exc:
                        log("WARN",
                            f"Corrupt cache {safetensors_path}: {exc}. Regenerating…")
                        try:
                            os.remove(safetensors_path)
                        except OSError:
                            pass

                # --- slow path: generate from WAV ---
                try:
                    log("INIT", f"Creating voice state from {wav_path} …")
                    voice_state = tts_model.get_state_for_audio_prompt(wav_path)
                    voices[voice_name] = voice_state
                    _save_safetensors(voice_state, safetensors_path)
                    log("INIT", f"Saved voice '{voice_name}' to {safetensors_path}")
                except Exception as exc:
                    log("ERROR", f"Failed to process {wav_path}: {exc}")
                    traceback.print_exc(file=sys.stderr)
    except Exception as exc:
        log("ERROR", f"Error scanning voices directory: {exc}")
        traceback.print_exc(file=sys.stderr)

    return voices


# ---------------------------------------------------------------------------
# WAV streaming helpers
# ---------------------------------------------------------------------------


def _make_wav_header(data_size: int, sample_rate: int = SAMPLE_RATE,
                     num_channels: int = 1, bits_per_sample: int = 32) -> bytes:
    """Create a WAV file header for IEEE float32 PCM audio."""
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    buf = io.BytesIO()
    # RIFF chunk descriptor
    buf.write(b"RIFF")
    riff_size = min(36 + data_size, 0xFFFFFFFF)
    buf.write(struct.pack("<I", riff_size))
    buf.write(b"WAVE")
    # fmt sub-chunk (IEEE float32)
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))         # Subchunk1Size
    buf.write(struct.pack("<H", 3))          # AudioFormat: IEEE float
    buf.write(struct.pack("<H", num_channels))
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", byte_rate))
    buf.write(struct.pack("<H", block_align))
    buf.write(struct.pack("<H", bits_per_sample))
    # data sub-chunk header
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    return buf.getvalue()


def wav_stream(tts_model, text: str, voice_state):
    """Yield WAV bytes incrementally from Pocket TTS audio stream.

    First yields the WAV header, then yields PCM audio chunks as
    they arrive. Uses a placeholder data size for true streaming
    (0xFFFFFFFF signals streaming/max size to clients).
    """
    # Placeholder size — clients decode until stream ends
    header = _make_wav_header(0xFFFFFFFF, SAMPLE_RATE)
    yield header

    for chunk in tts_model.generate_audio_stream(voice_state, text):
        # chunk is a float32 tensor, shape (N,) mono 24 kHz
        yield chunk.cpu().numpy().tobytes()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class TTSRequest(BaseModel):
    text: str
    voice: str


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="Pocket TTS Server")

# Allow browser access from Vite dev server (localhost:5173)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RequestValidationError)
async def _validation_handler(request: Request, exc: RequestValidationError):
    """Convert 422 → 400 to match the API contract."""
    from starlette.responses import JSONResponse
    return JSONResponse(status_code=400,
                        content={"detail": "Missing required fields"})


# Module-level globals set by main() during server startup.
_pocket_tts = None
_voices: dict = {}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/v1/voices")
def list_voices():
    """Return the list of available voice names."""
    return {"voices": sorted(_voices.keys())}


@app.post("/v1/tts")
def tts_endpoint(req: TTSRequest):
    """Generate streaming TTS audio for *text* using the named *voice*."""
    if req.voice not in _voices:
        available = ", ".join(sorted(_voices.keys()))
        raise HTTPException(
            status_code=400,
            detail=f"Unknown voice: {req.voice}. "
                   f"Available voices: {available}",
        )

    voice_state = _voices[req.voice]

    try:
        gen = wav_stream(_pocket_tts, req.text, voice_state)
        return StreamingResponse(
            gen,
            media_type="audio/wav",
            headers={"X-Voice": req.voice},
        )
    except Exception as exc:
        log("ERROR", f"TTS generation failed: {exc}")
        traceback.print_exc(file=sys.stderr)
        raise HTTPException(status_code=500,
                            detail="TTS generation failed")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    global _pocket_tts, _voices

    ap = argparse.ArgumentParser(description="Pocket TTS HTTP Streaming Server")
    ap.add_argument("--port", type=int, default=8080,
                    help="HTTP listen port (default: 8080)")
    ap.add_argument("--host", type=str, default="127.0.0.1",
                    help="HTTP listen host (default: 127.0.0.1)")
    ap.add_argument("--voices-dir", type=str, default=None,
                    help="Directory containing .wav files for voice cloning "
                         "(default: ../voices relative to this script)")
    args = ap.parse_args()

    # --- determine voices directory ---
    if args.voices_dir:
        voices_dir = os.path.normpath(args.voices_dir)
    else:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        voices_dir = os.path.normpath(os.path.join(script_dir, "..", "voices"))

    # --- load Pocket TTS model ---
    try:
        from pocket_tts import TTSModel
        log("INIT", "Loading Pocket TTS model …")
        _pocket_tts = TTSModel.load_model()
        log("INIT", "Pocket TTS model loaded")
    except Exception as exc:
        log("FATAL", f"Failed to load Pocket TTS model: {exc}")
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


    # --- load catalog voices (no voice cloning needed) ---
    _voices = {}
    log("INIT", f"Loading {len(CATALOG_VOICES)} catalog voices …")
    catalog_ok = 0
    for name in CATALOG_VOICES:
        try:
            _voices[name] = _pocket_tts.get_state_for_audio_prompt(name)
            catalog_ok += 1
        except Exception as exc:
            log("WARN", f"Catalog voice '{name}' failed: {exc}")
    log("INIT", f"Loaded {catalog_ok}/{len(CATALOG_VOICES)} catalog voices")

    # --- load custom voices from WAV files (needs voice cloning) ---
    has_vc = getattr(_pocket_tts, "has_voice_cloning", False)
    if has_vc:
        log("INIT", "Voice cloning available, scanning WAV files …")
        custom_voices = load_voices(_pocket_tts, voices_dir)
        for name, state in custom_voices.items():
            if name not in _voices:
                _voices[name] = state
    else:
        log("INIT", "Voice cloning not available (HF auth needed). "
            "Catalog voices only. See https://huggingface.co/kyutai/pocket-tts")

    if not _voices:
        log("FATAL", "No voices available.")
        sys.exit(1)

    log("INIT", f"Available voices: {sorted(_voices.keys())}")

    import uvicorn
    log("INFO", f"Starting Pocket TTS server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
