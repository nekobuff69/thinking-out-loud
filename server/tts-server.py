"""
Kyutai DSM TTS WebSocket Server.

A standalone Python+MLX server that loads the Kyutai TTS model and Mimi audio codec
via moshi-mlx, accepts WebSocket connections, receives synthesize messages, and
streams back PCM audio frames.

Usage:
    python server/tts-server.py                        # Full precision, port 8765
    python server/tts-server.py --quantize 8           # 8-bit quantized model
    python server/tts-server.py --quantize 4           # 4-bit quantized model
    python server/tts-server.py --port 9000            # Custom port
    python server/tts-server.py --hf-repo kyutai/tts-1.6b-en_fr  # Custom model

Protocol (all JSON text frames over WebSocket):
    Client → Server: {"type": "synthesize", "text": "...", "voice": "alba"}
    Server → Client: {"type": "pcm", "data": [float32_values]}
    Server → Client: {"type": "done"}
    Server → Client: {"type": "error", "message": "..."}
"""

import argparse
import asyncio
import json
import sys
import threading
import traceback
import mlx.core as mx
import mlx.nn as nn
import numpy as np
import sentencepiece
from websockets.asyncio.server import serve

# moshi-mlx imports
from moshi_mlx import models
from moshi_mlx.models.tts import (
    DEFAULT_DSM_TTS_REPO,
    DEFAULT_DSM_TTS_VOICE_REPO,
    TTSModel,
)
from moshi_mlx.utils.loaders import hf_get


def log(msg: str) -> None:
    """Timestamped log to stderr."""
    import datetime
    ts = datetime.datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", file=sys.stderr, flush=True)


class KyutaiTTSServer:
    """WebSocket server wrapping a Kyutai TTS model for streaming synthesis."""

    def __init__(
        self,
        port: int = 8765,
        quantize: int | None = None,
        hf_repo: str | None = None,
        voice_repo: str | None = None,
    ):
        self.port = port
        self.quantize = quantize
        self.hf_repo = hf_repo or DEFAULT_DSM_TTS_REPO
        self.voice_repo = voice_repo or DEFAULT_DSM_TTS_VOICE_REPO

        self.tts_model: TTSModel | None = None
        self.mimi = None  # For convenience, also accessible via tts_model.mimi
        self.loaded = False

        # Lock to serialize TTS generation (model caches are shared)
        self._gen_lock = threading.Lock()

    def load_model(self) -> None:
        """Load the TTS model and codec. Called once at startup."""
        log(f"Loading config from {self.hf_repo}...")
        raw_config_path = hf_get("config.json", self.hf_repo)
        with open(raw_config_path, "r") as f:
            raw_config = json.load(f)

        log("Loading Mimi weights...")
        mimi_weights = hf_get(raw_config["mimi_name"], self.hf_repo)

        moshi_name = raw_config.get("moshi_name", "model.safetensors")
        log(f"Loading LM weights ({moshi_name})...")
        moshi_weights = hf_get(moshi_name, self.hf_repo)

        log("Loading text tokenizer...")
        tokenizer_path = hf_get(raw_config["tokenizer_name"], self.hf_repo)

        log("Building LM config...")
        lm_config = models.LmConfig.from_config_dict(raw_config)
        lm = models.Lm(lm_config)
        lm.set_dtype(mx.bfloat16)

        log(f"Loading LM weights from {moshi_weights}...")
        lm.load_pytorch_weights(str(moshi_weights), lm_config, strict=True)

        if self.quantize is not None:
            log(f"Quantizing model to {self.quantize} bits...")
            nn.quantize(lm.depformer, bits=self.quantize)
            for layer in lm.transformer.layers:
                nn.quantize(layer.self_attn, bits=self.quantize)
                nn.quantize(layer.gating, bits=self.quantize)

        log("Loading text tokenizer...")
        text_tokenizer = sentencepiece.SentencePieceProcessor(str(tokenizer_path))

        log("Loading audio tokenizer (Mimi)...")
        generated_codebooks = lm_config.generated_codebooks
        audio_tokenizer = models.mimi.Mimi(models.mimi_202407(generated_codebooks))
        audio_tokenizer.load_pytorch_weights(str(mimi_weights), strict=True)

        log("Creating TTS model...")
        self.tts_model = TTSModel(
            lm,
            audio_tokenizer,
            text_tokenizer,
            voice_repo=self.voice_repo,
            raw_config=raw_config,
        )
        self.mimi = audio_tokenizer
        self.loaded = True
        log("Model loaded successfully!")

    async def handle_connection(self, websocket) -> None:
        """Handle a single WebSocket connection (one per model)."""
        remote = websocket.remote_address
        log(f"Connection opened: {remote}")

        if not self.loaded:
            await websocket.send(
                json.dumps({"type": "error", "message": "Model not loaded yet"})
            )
            return

        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    await websocket.send(
                        json.dumps({"type": "error", "message": "Invalid JSON"})
                    )
                    continue

                msg_type = data.get("type")

                if msg_type == "synthesize":
                    await self._handle_synthesize(websocket, data)
                else:
                    await websocket.send(
                        json.dumps({
                            "type": "error",
                            "message": f"Unknown message type: {msg_type}",
                        })
                    )
        except Exception as e:
            log(f"Connection error {remote}: {e}")
        finally:
            log(f"Connection closed: {remote}")

    async def _handle_synthesize(self, websocket, data: dict) -> None:
        """Process a synthesize request and stream PCM frames back."""
        text = data.get("text", "")
        voice = data.get("voice", "alba")

        if not text or not text.strip():
            await websocket.send(
                json.dumps({"type": "error", "message": "Empty text"})
            )
            return

        # Resolve voice embedding path (validates voice exists)
        try:
            voice_path = self.tts_model.get_voice_path(voice)
        except Exception as e:
            await websocket.send(
                json.dumps({
                    "type": "error",
                    "message": f"Invalid voice '{voice}': {e}",
                })
            )
            return

        # Prepare the script entries from text
        entries = self.tts_model.prepare_script([text])
        attributes = [self.tts_model.make_condition_attributes([voice_path])]

        # Bridge between generation thread and async loop.
        # asyncio.Queue is not thread-safe, so we use call_soon_threadsafe
        # to safely put items from the generation thread.
        loop = asyncio.get_running_loop()
        pcm_queue: asyncio.Queue = asyncio.Queue()
        error_occurred: list[str] = []  # mutable container for error message

        def on_frame(frame: mx.array) -> None:
            """Called for each generated audio frame during synthesis.
            Runs in the generation thread; pushes PCM to the async queue
            via call_soon_threadsafe."""
            pcm_frame = np.array(
                self.tts_model.mimi.decode_step(frame)
            ).astype(np.float32)
            loop.call_soon_threadsafe(
                pcm_queue.put_nowait,
                ("pcm", pcm_frame.flatten().tolist()),
            )

        def run_generation() -> None:
            """Synchronous generation callback. Runs in a thread."""
            try:
                with self._gen_lock:
                    self.tts_model.generate(
                        [entries],
                        attributes,
                        on_frame=on_frame,
                    )
            except Exception as e:
                traceback.print_exc()
                error_occurred.append(str(e))
            finally:
                loop.call_soon_threadsafe(
                    pcm_queue.put_nowait,
                    ("__sentinel__", None),
                )

        # Start generation in a thread so we can stream PCM as it arrives
        gen_future = loop.run_in_executor(None, run_generation)

        # Stream PCM frames from the queue to the WebSocket
        while True:
            item_type, item_data = await pcm_queue.get()

            if item_type == "__sentinel__":
                break

            if item_type == "pcm":
                await websocket.send(
                    json.dumps({"type": "pcm", "data": item_data})
                )

        # Wait for generation thread to finish
        await gen_future

        # Send final status
        if error_occurred:
            await websocket.send(
                json.dumps({
                    "type": "error",
                    "message": f"Generation failed: {error_occurred[0]}",
                })
            )
        else:
            await websocket.send(json.dumps({"type": "done"}))

    async def start(self) -> None:
        """Load model and start WebSocket server."""
        log(f"Loading TTS model from {self.hf_repo}...")
        if self.quantize:
            log(f"Quantization: {self.quantize}-bit")

        # Load model in a thread to avoid blocking the event loop
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self.load_model)

        log(f"Starting server on ws://localhost:{self.port}")
        async with serve(
            self.handle_connection,
            "localhost",
            self.port,
            # Allow larger messages for PCM JSON arrays
            max_size=2**24,  # 16 MB
        ):
            log(f"TTS server ready on ws://localhost:{self.port}")
            log(f"Model: {self.hf_repo}")
            log(f"Voice repo: {self.voice_repo}")
            await asyncio.Future()  # Run forever


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Kyutai DSM TTS WebSocket Server"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="WebSocket server port (default: 8765)",
    )
    parser.add_argument(
        "--quantize",
        type=int,
        choices=[4, 8],
        default=None,
        help="Quantize model to N bits for faster inference (4 or 8)",
    )
    parser.add_argument(
        "--hf-repo",
        type=str,
        default=None,
        help=f"HuggingFace repo for the TTS model (default: {DEFAULT_DSM_TTS_REPO})",
    )
    parser.add_argument(
        "--voice-repo",
        type=str,
        default=None,
        help=f"HuggingFace repo for voice embeddings (default: {DEFAULT_DSM_TTS_VOICE_REPO})",
    )

    args = parser.parse_args()

    server = KyutaiTTSServer(
        port=args.port,
        quantize=args.quantize,
        hf_repo=args.hf_repo,
        voice_repo=args.voice_repo,
    )

    try:
        asyncio.run(server.start())
    except KeyboardInterrupt:
        log("Server stopped by user")
        sys.exit(0)


if __name__ == "__main__":
    main()
