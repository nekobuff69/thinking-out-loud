"""
Kyutai DSM TTS Streaming WebSocket Server.

A standalone Python+MLX server that loads the Kyutai TTS model and Mimi audio codec
via moshi-mlx, accepts WebSocket connections, and implements the streaming TTS protocol
using incremental text feeding (TTSGen pattern).

Usage:
    python server/tts-server-streaming.py                 # Full precision, port 8765
    python server/tts-server-streaming.py --quantize 8    # 8-bit quantized
    python server/tts-server-streaming.py --port 9000     # Custom port

Protocol (all JSON text frames over WebSocket):
    Client -> Server:
        {"type": "open_stream",  "voice": "alba"}
        {"type": "text",         "data": "Hello world"}
        {"type": "close_stream"}
        {"type": "stop"}
    Server -> Client:
        {"type": "pcm",          "data": [float32_values]}
        {"type": "done"}
        {"type": "error",        "message": "..."}

The old tts-server.py stays untouched for replay fallback.
"""

import argparse
import asyncio
import json
import sys
import threading
import time
import traceback
from collections import deque

import mlx.core as mx
import mlx.nn as nn
import numpy as np
import sentencepiece
from websockets.asyncio.server import serve

from moshi_mlx import models
from moshi_mlx.models import LmGen
from moshi_mlx.models.mimi import Mimi, mimi_202407
from moshi_mlx.models.tts import (
    DEFAULT_DSM_TTS_REPO,
    DEFAULT_DSM_TTS_VOICE_REPO,
    ConditionTensor,
    Entry,
    Sampler,
    TTSModel,
    _make_null,
    script_to_entries,
)
from moshi_mlx.utils.loaders import hf_get


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

def _ts() -> str:
    return time.strftime("%H:%M:%S", time.localtime())


def log(label: str, msg: str) -> None:
    print(f"[{_ts()}] [{label}] {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# TTSGen — per-connection incremental TTS generator
# ---------------------------------------------------------------------------

class TTSGen:
    """Incremental TTS generator wrapping a shared TTSModel.

    One instance per active stream. Text entries appended dynamically as text
    chunks arrive via `append_text()`. Each call to `step()` performs one MLX
    forward pass and returns any completed PCM frames.

    The generator is stepped one pass at a time by the cooperative round-robin
    loop running in a background thread.
    """

    def __init__(self, tts_model: TTSModel, voice: str, model_label: str):
        self.tts_model = tts_model
        self.voice = voice
        self.model_label = model_label

        # Resolve voice path (validates voice exists)
        log("STREAM", f"{model_label} resolve voice '{voice}'")
        voice_path = tts_model.get_voice_path(voice)

        # Build conditioning attributes + tensors (mirrors TTSModel.generate)
        attr = tts_model.make_condition_attributes([voice_path], cfg_coef=1.0)
        self._build_conditioning(attr)

        # State machine state with empty entry queue
        self.state = tts_model.machine.new_state([])

        # LMGen — batch_size=1
        self.lm_gen = LmGen(
            tts_model.lm,
            max_steps=tts_model.max_gen_length,
            text_sampler=Sampler(temp=tts_model.temp),
            audio_sampler=Sampler(temp=tts_model.temp),
            batch_size=1,
            cfg_coef=tts_model.cfg_coef,
            on_text_hook=self._on_text_hook,
            on_audio_hook=self._on_audio_hook,
        )

        # Lifecycle flags
        self.closed = False       # close_stream received
        self.alive = True         # generator still running
        self._last_append_time = time.time()  # for no-text warning
        self._no_text_warned = False
        self.done = False         # all generation finished
        self.error: str | None = None
        self._done_sent = False   # guard against sending done twice

        # Reset model KV caches & Mimi state for fresh generation
        for c in tts_model.lm.transformer_cache:
            c.reset()
        for c in tts_model.lm.depformer_cache:
            c.reset()
        tts_model.mimi.reset_all()

        log("STREAM", f"{model_label} TTSGen ready for voice '{voice}'")

    # ------------------------------------------------------------------
    # Conditioning setup
    # ------------------------------------------------------------------

    def _build_conditioning(self, attr):
        """Build ct + cross_attention_src from ConditionAttributes."""

        if self.tts_model.cfg_coef != 1.0:
            attrs = [attr] + _make_null([attr])
        else:
            attrs = [attr]

        ct_list = []
        ca_list = []

        for a in attrs:
            ct = None
            ca = None
            for k, v in a.text.items():
                t = self.tts_model.lm.condition_provider.condition_tensor(k, v)
                tens = t.tensor.squeeze(0)
                ct = tens if ct is None else ct + tens
            ct_list.append(ct)
            for k, v in a.tensor.items():
                c = self.tts_model.lm.condition_provider.conditioners[k]
                ca_src = c.condition(v)
                if ca is None:
                    ca = ca_src
                else:
                    raise RuntimeError("multiple cross-attention conditioners")
            ca_list.append(ca)

        self.ct = ConditionTensor(mx.stack(ct_list, axis=0))
        if ca_list and ca_list[0] is not None:
            self.cross_attention_src = mx.concatenate(ca_list, axis=0)
        else:
            self.cross_attention_src = mx.zeros((len(attrs), 0, 0))

    # ------------------------------------------------------------------
    # LMGen hooks (called inside LmGen._step during model forward pass)
    # ------------------------------------------------------------------

    def _on_text_hook(self, text_tokens: mx.array) -> None:
        """Post-step: run sampled token through state machine, set next text input."""
        if not self.alive:
            return
        offset = self.lm_gen.step_idx
        token = text_tokens.tolist()[0][0]
        out_token, _ = self.tts_model.machine.process(offset, self.state, token)
        text_tokens[:] = mx.array([[out_token]], dtype=mx.int64)

    def _on_audio_hook(self, audio_tokens: mx.array) -> None:
        """Post-step: zero-out audio codebooks that haven't reached their delay."""
        if not self.alive:
            return
        offset = self.lm_gen.step_idx
        delays = self.tts_model.lm.delays
        for q in range(audio_tokens.shape[1]):
            d = delays[q]
            if offset < d + self.tts_model.delay_steps:
                audio_tokens[:, q] = self.tts_model.machine.token_ids.zero

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def append_text(self, text: str) -> None:
        """Append text chunk as entries to the state machine's queue."""
        if self.closed or self.done or not self.alive:
            return
        if not text.strip():
            return
        entries = script_to_entries(
            self.tts_model.tokenizer,
            self.tts_model.machine.token_ids,
            self.tts_model.mimi.frame_rate,
            [text],
        )
        self.state.entries.extend(entries)
        self._last_append_time = time.time()

    def close(self) -> None:
        """Signal end of text. Generator will drain pending entries and finish."""
        self.closed = True

    def step(self) -> list[list[float]]:
        """One forward pass. Returns list of PCM frame arrays (may be empty)."""
        if not self.alive or self.done:
            return []

        pcm_out: list[list[float]] = []

        # Termination check: if end_step set and enough trailing steps done
        if self.state.end_step is not None:
            need = self.state.end_step + self.tts_model.delay_steps + self.tts_model.final_padding
            if self.lm_gen.step_idx >= need:
                self.done = True
                return []

        # If no entries and not closed, inject silence placeholder.
        # This keeps the model alive (generating frames) while waiting
        # for text to arrive. However, the audio from these padding steps
        # is often non-silent garble with quantized models. We skip
        # sending it to the client — only real text entries should produce
        # audible output.
        is_padding_step = False
        if not self.state.entries and not self.closed:
            self.state.entries.append(Entry(tokens=[], text="", padding=10))
            is_padding_step = True

        # Forward pass
        missing = self.tts_model.lm.n_q - self.tts_model.lm.dep_q
        inp = mx.ones((1, missing), dtype=mx.int64) * self.tts_model.machine.token_ids.zero

        try:
            self.lm_gen.step(inp, ct=self.ct, cross_attention_src=self.cross_attention_src)
        except Exception as exc:
            log("ERROR", f"{self.model_label} step: {exc}")
            traceback.print_exc()
            self.alive = False
            self.done = True
            self.error = str(exc)
            return []

        # Check for completed audio frame (after acoustic delay)
        frame = self.lm_gen.last_audio_tokens()
        if frame is not None and (frame != self.tts_model.machine.token_ids.zero).all():
            # Always decode through Mimi to keep its internal state in sync
            # (Mimi uses stateful convolutional layers — skipping frames
            # desynchronizes the decoder, causing crackles).
            # But discard padding PCM — it's garble, not real speech.
            frame_3d = mx.array(frame)[:, :, None]
            pcm = np.array(self.tts_model.mimi.decode_step(frame_3d)).astype(np.float32)
            if not is_padding_step:
                pcm_out.append(pcm.flatten().tolist())

        return pcm_out

    def stop(self) -> None:
        """Immediate kill — no more generation, no done message."""
        self.alive = False
        self.done = True
        self.error = None
        self._done_sent = True  # suppress done message


# ---------------------------------------------------------------------------
# KyutaiStreamingServer
# ---------------------------------------------------------------------------

class KyutaiStreamingServer:
    """WebSocket server with cooperative round-robin TTSGen stepping."""

    def __init__(
        self,
        port: int = 8765,
        quantize: int | None = None,
        hf_repo: str | None = None,
        voice_repo: str | None = None,
        step_interval: float = 0.001,
    ):
        self.port = port
        self.quantize = quantize
        self.hf_repo = hf_repo or DEFAULT_DSM_TTS_REPO
        self.voice_repo = voice_repo or DEFAULT_DSM_TTS_VOICE_REPO
        self.step_interval = step_interval

        self.tts_model: TTSModel | None = None
        self.loaded = False

        # Active generators: conn_key -> TTSGen
        self._gens: dict[int, TTSGen] = {}
        self._gens_lock = threading.Lock()
        self._next_key = 0

        # PCM queues: conn_key -> asyncio.Queue
        self._pcm_queues: dict[int, asyncio.Queue] = {}

        # Stepping thread state
        self._stepping = False
        self._stepping_thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    # ------------------------------------------------------------------
    # Model loading
    # ------------------------------------------------------------------

    def load_model(self) -> None:
        """Load the TTS model and Mimi codec. Called once at startup."""
        log("INFO", f"Load config from {self.hf_repo}")
        cfg_path = hf_get("config.json", self.hf_repo)
        with open(cfg_path) as f:
            raw_cfg = json.load(f)

        log("INFO", "Load Mimi weights")
        mimi_w = hf_get(raw_cfg["mimi_name"], self.hf_repo)

        mname = raw_cfg.get("moshi_name", "model.safetensors")
        log("INFO", f"Load LM weights ({mname})")
        lm_w = hf_get(mname, self.hf_repo)

        log("INFO", "Load text tokenizer")
        tok_p = hf_get(raw_cfg["tokenizer_name"], self.hf_repo)

        log("INFO", "Build LM")
        lm_cfg = models.LmConfig.from_config_dict(raw_cfg)
        lm = models.Lm(lm_cfg)
        lm.set_dtype(mx.bfloat16)

        log("INFO", "Load LM weights")
        lm.load_pytorch_weights(str(lm_w), lm_cfg, strict=True)

        if self.quantize is not None:
            log("INFO", f"Quantize {self.quantize}-bit")
            nn.quantize(lm.depformer, bits=self.quantize)
            for layer in lm.transformer.layers:
                nn.quantize(layer.self_attn, bits=self.quantize)
                nn.quantize(layer.gating, bits=self.quantize)

        log("INFO", "Load text tokenizer")
        tok = sentencepiece.SentencePieceProcessor(str(tok_p))

        log("INFO", "Load Mimi")
        gcb = lm_cfg.generated_codebooks
        mimi = Mimi(mimi_202407(gcb))
        mimi.load_pytorch_weights(str(mimi_w), strict=True)

        log("INFO", "Create TTSModel")
        self.tts_model = TTSModel(
            lm, mimi, tok,
            voice_repo=self.voice_repo,
            raw_config=raw_cfg,
        )
        self.loaded = True
        log("INFO", "Model loaded")

    # ------------------------------------------------------------------
    # Connection handler
    # ------------------------------------------------------------------

    async def handle_connection(self, websocket) -> None:
        """Handle one WebSocket connection (one per model)."""
        remote = websocket.remote_address
        log("CONNECT", str(remote))

        if not self.loaded:
            await websocket.send(json.dumps({"type": "error", "message": "Model not loaded"}))
            return

        conn_key = self._next_key
        self._next_key += 1

        pcm_queue: asyncio.Queue = asyncio.Queue()
        self._pcm_queues[conn_key] = pcm_queue
        gen: TTSGen | None = None

        # Background sender: drain PCM queue -> WebSocket
        async def pcm_sender():
            sent_done = False
            try:
                while True:
                    item = await pcm_queue.get()
                    if item is None:
                        break
                    t = item["type"]
                    if t == "done":
                        if not sent_done:
                            await websocket.send(json.dumps(item))
                            sent_done = True
                        break
                    elif t == "error":
                        await websocket.send(json.dumps(item))
                        break
                    elif t == "pcm":
                        await websocket.send(json.dumps(item))
            except Exception:
                pass

        sender_task = asyncio.create_task(pcm_sender())

        try:
            async for msg_text in websocket:
                try:
                    msg = json.loads(msg_text)
                except json.JSONDecodeError:
                    await websocket.send(json.dumps({"type": "error", "message": "Invalid JSON"}))
                    continue

                mt = msg.get("type")

                if mt == "open_stream":
                    if gen is not None and gen.alive:
                        await websocket.send(json.dumps({"type": "error", "message": "Stream already active"}))
                        continue
                    voice = msg.get("voice", "alba")
                    try:
                        gen = TTSGen(self.tts_model, voice, f"conn-{remote[1]}")
                        with self._gens_lock:
                            self._gens[conn_key] = gen
                        log("STREAM", f"{gen.model_label} open voice={voice}")
                    except Exception as exc:
                        log("ERROR", f"open_stream failed: {exc}")
                        await websocket.send(json.dumps({"type": "error", "message": str(exc)}))
                        gen = None

                elif mt == "text":
                    if gen is None or not gen.alive:
                        await websocket.send(json.dumps({"type": "error", "message": "No active stream"}))
                        continue
                    data = msg.get("data", "")
                    if data:
                        log("TEXT", f"{gen.model_label} {len(data)}ch ~{len(data.split())}w")
                    gen.append_text(data)

                elif mt == "close_stream":
                    if gen is None or not gen.alive:
                        await websocket.send(json.dumps({"type": "error", "message": "No active stream"}))
                        continue
                    log("STREAM", f"{gen.model_label} close_stream")
                    gen.close()

                elif mt == "stop":
                    log("DISCONNECT", f"{gen.model_label if gen else '?'} stop")
                    if gen is not None:
                        gen.stop()
                        with self._gens_lock:
                            self._gens.pop(conn_key, None)

                else:
                    await websocket.send(json.dumps({"type": "error", "message": f"Unknown type: {mt}"}))

        except Exception as exc:
            log("ERROR", f"conn {remote}: {exc}")
        finally:
            log("DISCONNECT", f"close {remote}")
            if gen is not None:
                gen.stop()
            with self._gens_lock:
                self._gens.pop(conn_key, None)
            pcm_queue.put_nowait(None)  # stop sender
            await sender_task
            self._pcm_queues.pop(conn_key, None)

    # ------------------------------------------------------------------
    # Cooperative stepping loop (background thread)
    # ------------------------------------------------------------------

    def _stepping_loop(self) -> None:
        """Round-robin: each active TTSGen gets one MLX step per round."""
        log("GEN", "Stepping loop start")
        while self._stepping:
            loop = self._loop
            if loop is None:
                time.sleep(self.step_interval)
                continue

            # Snapshot active gens
            with self._gens_lock:
                keys = list(self._gens.keys())
                snap = [(k, self._gens[k]) for k in keys]

            if not snap:
                time.sleep(self.step_interval * 10)
                continue

            any_work = False
            to_remove: list[int] = []
            now = time.time()

            for ck, g in snap:
                # Warn if text paused for 5+ seconds
                if g.alive and not g.closed and not g._no_text_warned:
                    idle = now - g._last_append_time
                    if idle > 5.0:
                        log("WARN", f"{g.model_label} no text for {idle:.0f}s")
                        g._no_text_warned = True
                if not g.alive or g.done:
                    continue

                frames = g.step()
                if frames:
                    any_work = True
                    q = self._pcm_queues.get(ck)
                    if q is not None:
                        for pcm in frames:
                            loop.call_soon_threadsafe(q.put_nowait, {"type": "pcm", "data": pcm})

                # Check completion
                if g.done and g.error is None and not g._done_sent:
                    g._done_sent = True
                    q = self._pcm_queues.get(ck)
                    if q is not None:
                        if g.closed:
                            log("GEN", f"{g.model_label} done")
                            loop.call_soon_threadsafe(q.put_nowait, {"type": "done"})
                        else:
                            # stopped, no done message
                            pass
                    to_remove.append(ck)

                elif g.error is not None:
                    log("ERROR", f"{g.model_label} fail: {g.error}")
                    q = self._pcm_queues.get(ck)
                    if q is not None:
                        loop.call_soon_threadsafe(q.put_nowait, {"type": "error", "message": g.error})
                    to_remove.append(ck)

            # Cleanup finished gens
            if to_remove:
                with self._gens_lock:
                    for ck in to_remove:
                        self._gens.pop(ck, None)

            sleep_dur = self.step_interval * (5 if not any_work else 1)
            time.sleep(sleep_dur)

        log("GEN", "Stepping loop stop")

    # ------------------------------------------------------------------
    # Server lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Load model and start WebSocket server."""
        log("INFO", f"Load model from {self.hf_repo}")
        if self.quantize:
            log("INFO", f"Quantize {self.quantize}-bit")

        self._loop = asyncio.get_running_loop()
        await self._loop.run_in_executor(None, self.load_model)

        # Start stepping thread
        self._stepping = True
        self._stepping_thread = threading.Thread(target=self._stepping_loop, daemon=True)
        self._stepping_thread.start()

        log("INFO", f"Listen ws://localhost:{self.port}")
        async with serve(
            self.handle_connection,
            "localhost",
            self.port,
            max_size=2**24,
        ):
            log("INFO", f"Streaming server ready ws://localhost:{self.port}")
            await asyncio.Future()  # run forever


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="Kyutai DSM TTS Streaming Server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--quantize", type=int, choices=[4, 8], default=None)
    ap.add_argument("--hf-repo", type=str, default=None)
    ap.add_argument("--voice-repo", type=str, default=None)
    ap.add_argument("--step-interval", type=float, default=0.001)
    args = ap.parse_args()

    srv = KyutaiStreamingServer(
        port=args.port, quantize=args.quantize,
        hf_repo=args.hf_repo, voice_repo=args.voice_repo,
        step_interval=args.step_interval,
    )

    try:
        asyncio.run(srv.start())
    except KeyboardInterrupt:
        log("INFO", "Stopped")
        sys.exit(0)


if __name__ == "__main__":
    main()
