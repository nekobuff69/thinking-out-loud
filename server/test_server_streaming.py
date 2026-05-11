"""
Integration tests for the streaming TTS server (tts-server-streaming.py).

Usage:
    # Start the streaming server in another terminal first:
    python server/tts-server-streaming.py

    # Then run this test:
    python server/test_server_streaming.py

Tests:
    1. Open stream → send text → close → verify non-silent PCM + done
    2. Invalid voice → receive error message
    3. Stop → immediate clean shutdown
    4. Two concurrent streams → both receive PCM frames
    5. Unknown message type → receive error
    6. Empty text → still produces PCM (text message with empty data is valid)
"""

import asyncio
import importlib.util
import json
import os
import sys
import time
from unittest.mock import MagicMock, patch
from websockets.asyncio.client import connect

# Load the server module to access TTSGen for unit tests
# (filename has hyphens, so importlib is needed)
_server_mod_path = os.path.join(os.path.dirname(__file__), "tts-server-streaming.py")
_spec = importlib.util.spec_from_file_location("tts_server_streaming_mod", _server_mod_path)
_tts_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_tts_mod)
TTSGen = _tts_mod.TTSGen

SERVER_URL = "ws://localhost:8765"


async def test_basic_stream():
    """Open stream, send text, close, verify non-silent PCM + done."""
    async with connect(SERVER_URL) as ws:
        # Open stream
        await ws.send(json.dumps({
            "type": "open_stream",
            "voice": "alba-mackenna/casual.wav",
        }))

        # Send text chunks
        await ws.send(json.dumps({
            "type": "text",
            "data": "Hello world, this is a test of streaming TTS.",
        }))

        # Close stream
        await ws.send(json.dumps({"type": "close_stream"}))

        pcm_frames = []
        all_silent = True
        got_done = False

        async for message in ws:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "pcm":
                pcm = data.get("data", [])
                pcm_frames.append(pcm)
                if any(abs(s) > 1e-6 for s in pcm):
                    all_silent = False

            elif msg_type == "done":
                got_done = True
                break

            elif msg_type == "error":
                print(f"  FAIL: Unexpected error: {data.get('message')}")
                return False

    if not got_done:
        print("  FAIL: No 'done' message received")
        return False

    if len(pcm_frames) == 0:
        print("  FAIL: No PCM frames received")
        return False

    if all_silent:
        print("  FAIL: All PCM frames are silent (all zeros)")
        return False

    print(f"  PASS: {len(pcm_frames)} PCM frames, "
          f"{'non-silent' if not all_silent else 'SILENT'} audio, got done")
    return True


async def test_incremental_text():
    """Send multiple text chunks before close, verify smooth PCM."""
    async with connect(SERVER_URL) as ws:
        await ws.send(json.dumps({
            "type": "open_stream",
            "voice": "alba-mackenna/casual.wav",
        }))

        # Send text in multiple chunks (simulating incremental tokens)
        await ws.send(json.dumps({
            "type": "text",
            "data": "I think",
        }))
        await asyncio.sleep(0.05)
        await ws.send(json.dumps({
            "type": "text",
            "data": " therefore",
        }))
        await asyncio.sleep(0.05)
        await ws.send(json.dumps({
            "type": "text",
            "data": " I am.",
        }))

        await ws.send(json.dumps({"type": "close_stream"}))

        pcm_frames = []
        all_silent = True
        got_done = False

        async for message in ws:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "pcm":
                pcm = data.get("data", [])
                pcm_frames.append(pcm)
                if any(abs(s) > 1e-6 for s in pcm):
                    all_silent = False
            elif msg_type == "done":
                got_done = True
                break
            elif msg_type == "error":
                print(f"  FAIL: Unexpected error: {data.get('message')}")
                return False

    if not got_done:
        print("  FAIL: No 'done' message for incremental text")
        return False
    if len(pcm_frames) == 0:
        print("  FAIL: No PCM frames for incremental text")
        return False
    if all_silent:
        print("  FAIL: All PCM frames silent for incremental text")
        return False

    print(f"  PASS: Incremental text — {len(pcm_frames)} PCM frames, non-silent")
    return True


async def test_invalid_voice():
    """Open stream with invalid voice -> error message."""
    async with connect(SERVER_URL) as ws:
        await ws.send(json.dumps({
            "type": "open_stream",
            "voice": "nonexistent_voice_xyz",
        }))

        async for message in ws:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "error":
                err_msg = data.get("message", "")
                print(f"  PASS: Invalid voice error: {err_msg[:80]}...")
                return True

            elif msg_type == "pcm":
                print("  FAIL: Received PCM for invalid voice")
                return False

            elif msg_type == "done":
                print("  FAIL: Received done for invalid voice")
                return False

    print("  FAIL: Connection closed without error for invalid voice")
    return False


async def test_stop():
    """Send stop during generation -> immediate clean stop."""
    async with connect(SERVER_URL) as ws:
        await ws.send(json.dumps({
            "type": "open_stream",
            "voice": "alba-mackenna/casual.wav",
        }))

        # Send a lot of text (long enough to take time)
        await ws.send(json.dumps({
            "type": "text",
            "data": ("The quick brown fox jumps over the lazy dog. " * 10),
        }))

        # Don't close — send stop immediately
        await ws.send(json.dumps({"type": "stop"}))

        # Give a tiny window for any stray PCM before stop takes effect
        await asyncio.sleep(0.2)

        # Connection should be cleanly closeable — server cleaned up
        # If stop worked, no more messages should arrive
        # Try to receive for a short time
        try:
            async for message in ws:
                data = json.loads(message)
                msg_type = data.get("type")
                # We might get a few PCM frames that were already queued
                if msg_type not in ("pcm",):
                    print(f"  FAIL: Got unexpected '{msg_type}' after stop")
                    return False
            # If we got here, loop ended naturally (connection closed)
        except Exception:
            # Connection closed before iteration ended, that's OK
            pass

    print("  PASS: Stop cleaned up generation")
    return True


async def test_concurrent_streams():
    """Two concurrent connections -> both receive PCM."""
    async def stream_one(id: int) -> bool:
        try:
            async with connect(SERVER_URL) as ws:
                await ws.send(json.dumps({
                    "type": "open_stream",
                    "voice": "alba-mackenna/casual.wav",
                }))
                await ws.send(json.dumps({
                    "type": "text",
                    "data": f"Hello from stream number {id}.",
                }))
                await ws.send(json.dumps({"type": "close_stream"}))

                pcm_count = 0
                async for message in ws:
                    data = json.loads(message)
                    if data.get("type") == "pcm":
                        pcm_count += 1
                    elif data.get("type") == "done":
                        break
                    elif data.get("type") == "error":
                        print(f"  FAIL (stream {id}): error: {data.get('message')}")
                        return False
                return pcm_count > 0
        except Exception as e:
            print(f"  FAIL (stream {id}): exception: {e}")
            return False

    result1, result2 = await asyncio.gather(
        stream_one(1), stream_one(2)
    )

    if result1 and result2:
        print("  PASS: Both streams received PCM")
        return True
    else:
        print(f"  FAIL: Stream results: 1={result1}, 2={result2}")
        return False


async def test_unknown_message_type():
    """Send unknown message type -> error."""
    async with connect(SERVER_URL) as ws:
        await ws.send(json.dumps({"type": "unknown_command"}))

        async for message in ws:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "error":
                print(f"  PASS: Unknown message type error")
                return True

    print("  FAIL: No error for unknown message type")
    return False


async def test_stop_no_stream():
    """Send stop without open stream -> clean."""
    async with connect(SERVER_URL) as ws:
        await ws.send(json.dumps({"type": "stop"}))

        # Should not crash. Server might send nothing or keep connection open.
        await asyncio.sleep(0.1)
        print("  PASS: Stop without stream did not crash")
        return True


# ---------------------------------------------------------------------------
# Unit tests for per-gen state isolation and warmup (no server needed)
# ---------------------------------------------------------------------------


def _create_mock_tts_model():
    """Create a mocked TTSModel with all attributes TTSGen.__init__ accesses.

    The mock returns controllable values for KV cache factories, Mimi,
    condition_tensor, and state machine so unit tests can verify isolation
    behavior without loading actual model weights.
    """
    import mlx.core as mx

    tts_model = MagicMock()

    # Voice path lookup
    tts_model.get_voice_path.return_value = "/mock/voice.wav"

    # Condition attributes — needs .text with one entry and an empty .tensor
    # so _build_conditioning produces a valid ct but never accesses conditioners
    attr = MagicMock(spec=["text", "tensor"])
    attr.text = {"dummy": "value"}
    attr.tensor = {}
    tts_model.make_condition_attributes.return_value = attr

    # LM configuration
    lm = MagicMock()
    lm.n_q = 32
    lm.dep_q = 8
    lm_cfg = MagicMock()
    lm_cfg.audio_codebooks = 8
    lm.cfg = lm_cfg
    lm.delays = [0, 1, 2, 3, 4, 5, 6, 7]
    tts_model.lm = lm

    # Condition tensor provider — returns a mock whose .tensor.squeeze
    # yields a real mlx array so ConditionTensor(mx.stack(...)) works
    ct_result = MagicMock()
    ct_result.tensor.squeeze.return_value = mx.array([0.0])
    cond_provider = MagicMock()
    cond_provider.condition_tensor.return_value = ct_result
    lm.condition_provider = cond_provider

    # KV cache factories — each call returns a fresh mock so per-gen isolation
    # can be verified with identity checks (is not)
    lm.transformer.make_rot_cache.side_effect = lambda: MagicMock(spec=list)

    dep_mock = MagicMock()
    dep_slice = MagicMock()
    dep_slice.transformer.make_cache.side_effect = lambda: MagicMock(spec=list)
    dep_mock.slices = [dep_slice]
    lm.depformer = dep_mock

    # TTSModel-level config
    tts_model.cfg_coef = 1.0
    tts_model.max_gen_length = 3000
    tts_model.temp = 0.8
    tts_model.delay_steps = 10
    tts_model.final_padding = 10

    # State machine
    machine = MagicMock()
    machine.token_ids.zero = 0
    state_mock = MagicMock()
    state_mock.entries = []
    state_mock.end_step = None
    machine.new_state.return_value = state_mock
    tts_model.machine = machine

    # Shared Mimi (for weight reference — update() is a no-op on mock)
    tts_model.mimi = MagicMock()
    tts_model.mimi.parameters.return_value = {}

    # Tokenizer (only used in append_text, not __init__)
    tts_model.tokenizer = MagicMock()

    return tts_model


async def test_cache_isolation():
    """Two TTSGens have independent transformer_cache, depformer_cache, Mimi.

    Verifies:
    - Each gen creates its own KV cache objects (separate references)
    - Each gen creates its own Mimi instance (separate codec state)
    - _swap_caches_in() assigns the gen's own caches to the shared model ref
    """
    import mlx.core as mx

    tts_model = _create_mock_tts_model()

    with (
        patch.object(_tts_mod, "LmGen") as mock_lmgen_cls,
        patch.object(_tts_mod, "Mimi") as mock_mimi_cls,
        patch.object(_tts_mod, "mimi_202407"),
    ):
        # Configure the LmGen mock instance returned by the constructor
        lm_gen_instance = MagicMock()
        lm_gen_instance.step_idx = 0
        lm_gen_instance.last_audio_tokens.return_value = None
        lm_gen_instance.step = MagicMock()
        mock_lmgen_cls.return_value = lm_gen_instance

        # Each Mimi() call returns a distinct mock instance
        mimi1 = MagicMock()
        mimi2 = MagicMock()
        mock_mimi_cls.side_effect = [mimi1, mimi2]

        gen1 = TTSGen(tts_model, "voice1", "gen1")
        gen2 = TTSGen(tts_model, "voice2", "gen2")

        # Each gen must have its OWN cache objects
        assert gen1.transformer_cache is not gen2.transformer_cache, (
            "Each gen should have its own transformer_cache"
        )
        assert gen1.depformer_cache is not gen2.depformer_cache, (
            "Each gen should have its own depformer_cache"
        )
        assert gen1.mimi is not gen2.mimi, (
            "Each gen should have its own Mimi instance"
        )

        # _swap_caches_in() must point the shared model to the gen's caches
        gen1._swap_caches_in()
        assert tts_model.lm.transformer_cache is gen1.transformer_cache, (
            "gen1._swap_caches_in should assign gen1.transformer_cache"
        )
        assert tts_model.lm.depformer_cache is gen1.depformer_cache, (
            "gen1._swap_caches_in should assign gen1.depformer_cache"
        )

        gen2._swap_caches_in()
        assert tts_model.lm.transformer_cache is gen2.transformer_cache, (
            "gen2._swap_caches_in should assign gen2.transformer_cache"
        )
        assert tts_model.lm.depformer_cache is gen2.depformer_cache, (
            "gen2._swap_caches_in should assign gen2.depformer_cache"
        )

    print("  PASS: Cache isolation — separate KV caches, Mimi, and swap")
    return True


async def test_padding_frame_handling():
    """Padding steps call mimi.decode_step() but return empty pcm_out.

    When step() is called without entries and not closed, it injects a padding
    entry to keep the model alive. The generated audio tokens (if any) are
    decoded through the per-gen Mimi to keep codec state in sync, but the
    resulting PCM is discarded — not sent to the client.
    """
    import mlx.core as mx
    import numpy as np

    tts_model = _create_mock_tts_model()

    with (
        patch.object(_tts_mod, "LmGen") as mock_lmgen_cls,
        patch.object(_tts_mod, "Mimi") as mock_mimi_cls,
        patch.object(_tts_mod, "mimi_202407"),
    ):
        # Configure LmGen mock instance
        lm_gen_instance = MagicMock()
        lm_gen_instance.step_idx = 0
        lm_gen_instance.last_audio_tokens.return_value = mx.array([[1, 2, 3], [4, 5, 6]])
        lm_gen_instance.step = MagicMock()
        mock_lmgen_cls.return_value = lm_gen_instance

        # Mock Mimi instance — decode_step returns PCM data
        mimi_mock = MagicMock()
        mimi_mock.decode_step.return_value = [[0.1, 0.2]]
        mock_mimi_cls.return_value = mimi_mock

        # Create gen with empty entries (no text fed yet)
        gen = TTSGen(tts_model, "voice1", "gen1")

        # State starts with empty entries — this triggers padding path
        assert len(gen.state.entries) == 0, "State entries should be empty initially"
        assert not gen.closed, "Gen should not be closed"

        # Step produces padding because entries empty + not closed
        pcm_out = gen.step()

        # Padding step must still decode through Mimi to sync codec state
        assert mimi_mock.decode_step.called, (
            "decode_step should be called for padding steps (codec sync)"
        )

        # But the PCM must be discarded — not returned to client
        assert len(pcm_out) == 0, (
            "Padding step should return empty pcm_out (PCM discarded)"
        )

    print("  PASS: Padding frame — decode_step called, pcm_out empty")
    return True


async def test_warmup_flag():
    """TTSGen.warmed_up starts False, transitions to True after first audio.

    The warmed_up flag is used by the stepping loop to decide whether a gen
    needs exclusive warmup steps or can join round-robin.
    """
    import mlx.core as mx

    tts_model = _create_mock_tts_model()

    with (
        patch.object(_tts_mod, "LmGen") as mock_lmgen_cls,
        patch.object(_tts_mod, "Mimi") as mock_mimi_cls,
        patch.object(_tts_mod, "mimi_202407"),
    ):
        # Configure LmGen mock — starts with no audio frame
        lm_gen_instance = MagicMock()
        lm_gen_instance.step_idx = 0
        lm_gen_instance.step = MagicMock()
        mock_lmgen_cls.return_value = lm_gen_instance

        # Mock Mimi
        mimi_mock = MagicMock()
        mimi_mock.decode_step.return_value = [[0.1, 0.2]]
        mock_mimi_cls.return_value = mimi_mock

        gen = TTSGen(tts_model, "voice1", "gen1")

        # warmed_up starts False
        assert gen.warmed_up is False, (
            "warmed_up should be False on construction"
        )

        # Add entries so step() is NOT a padding step
        gen.state.entries.append(MagicMock())

        # First step — make it produce a non-zero audio frame
        lm_gen_instance.last_audio_tokens.return_value = mx.array([[1, 2, 3], [4, 5, 6]])
        pcm_out = gen.step()

        # After first non-padding audio frame, warmed_up becomes True
        assert gen.warmed_up is True, (
            "warmed_up should be True after first non-padding audio frame"
        )
        assert len(pcm_out) > 0, (
            "Non-padding step should produce PCM output"
        )

    print("  PASS: Warmup flag — False on init, True after first audio")
    return True


async def test_staggered_warmup_loop():
    """Two concurrent TTSGens: cold gen runs exclusively until warm,
    then both join round-robin.

    Simulates the stepping loop's warmup scheduling to verify each cold gen
    runs in a tight exclusive loop until its first audio frame, then graduates
    to shared round-robin. This tests the scheduling behavior decoupled from
    the server's thread/WebSocket infrastructure.
    """
    import mlx.core as mx

    tts_model = _create_mock_tts_model()

    with (
        patch.object(_tts_mod, "LmGen") as mock_lmgen_cls,
        patch.object(_tts_mod, "Mimi") as mock_mimi_cls,
        patch.object(_tts_mod, "mimi_202407"),
    ):
        # Shared call log: (gen_id, warmed_up_before_step)
        call_log = []

        # --- gen1: warms up after 3 non-padding steps ---
        lm1 = MagicMock()
        lm1.step_idx = 0
        lm1_calls = [0]

        def step1_side(*a, **kw):
            warmed_before = lm1._gen_ref.warmed_up
            lm1_calls[0] += 1
            lm1.step_idx = lm1_calls[0] * 10
            if lm1_calls[0] >= 3:
                lm1.last_audio_tokens.return_value = mx.array([[1]])
            else:
                lm1.last_audio_tokens.return_value = mx.array([[0]])
            call_log.append((1, warmed_before))

        lm1.step = MagicMock(side_effect=step1_side)
        lm1.last_audio_tokens = MagicMock(return_value=mx.array([[0]]))
        mimi1 = MagicMock()
        mimi1.decode_step.return_value = [[0.1]]

        # --- gen2: warms up after 6 non-padding steps ---
        lm2 = MagicMock()
        lm2.step_idx = 0
        lm2_calls = [0]

        def step2_side(*a, **kw):
            warmed_before = lm2._gen_ref.warmed_up
            lm2_calls[0] += 1
            lm2.step_idx = lm2_calls[0] * 10
            if lm2_calls[0] >= 6:
                lm2.last_audio_tokens.return_value = mx.array([[1]])
            else:
                lm2.last_audio_tokens.return_value = mx.array([[0]])
            call_log.append((2, warmed_before))

        lm2.step = MagicMock(side_effect=step2_side)
        lm2.last_audio_tokens = MagicMock(return_value=mx.array([[0]]))
        mimi2 = MagicMock()
        mimi2.decode_step.return_value = [[0.1]]

        mock_lmgen_cls.side_effect = [lm1, lm2]
        mock_mimi_cls.side_effect = [mimi1, mimi2]

        gen1 = TTSGen(tts_model, "v1", "gen1")
        gen2 = TTSGen(tts_model, "v2", "gen2")

        # Wire back-references so side_effects can read gen.warmed_up
        lm1._gen_ref = gen1
        lm2._gen_ref = gen2

        # Feed entries so steps are non-padding (audio-producing)
        gen1.state.entries.append(MagicMock())
        gen2.state.entries.append(MagicMock())

        # ------------------------------------------------------------------
        # Simulate stepping loop scheduling (mirrors _stepping_loop() logic)
        # ------------------------------------------------------------------
        def simulate_stepping(gens_dict, max_outer=5):
            """One outer-iteration pass of stepping loop warmup scheduling.

            Mirrors the scheduling logic in KyutaiStreamingServer._stepping_loop():
            1. Exclusive warmup: each cold gen runs in tight inner loop until warm
            2. Round-robin: one step per warm gen
            """
            for _ in range(max_outer):
                snap = list(gens_dict.items())
                to_remove = []

                # Exclusive warmup for cold gens
                for ck, g in snap:
                    if not g.warmed_up and g.alive and not g.done:
                        while not g.warmed_up and g.alive and not g.done:
                            g.step()
                            if g.done or g.error:
                                to_remove.append(ck)
                                break

                # Round-robin for warm gens
                for ck, g in snap:
                    if g.warmed_up and g.alive and not g.done:
                        g.step()
                        if g.done:
                            to_remove.append(ck)
                        elif g.error:
                            to_remove.append(ck)

                for ck in to_remove:
                    gens_dict.pop(ck, None)

        gens = {1: gen1, 2: gen2}
        simulate_stepping(gens, max_outer=5)

        # --- Assertions ---

        # 1. First 3 calls are all gen1 (exclusive warmup, no gen2 interleaving)
        first_three = call_log[:3]
        assert all(g == 1 for g, _ in first_three), (
            "First 3 steps must be gen1 (exclusive warmup): got %s"
            % [g for g, _ in call_log]
        )

        # 2. gen2 gets ZERO steps during gen1's warmup
        gen2_during_gen1 = [x for x in call_log[:3] if x[0] == 2]
        assert len(gen2_during_gen1) == 0, (
            "gen2 should get 0 steps during gen1's warmup"
        )

        # 3. gen1 is cold before each warmup step
        gen1_calls = [x for x in call_log if x[0] == 1]
        assert gen1_calls[0][1] == False, "gen1 cold before step 1"
        assert gen1_calls[1][1] == False, "gen1 cold before step 2"
        assert gen1_calls[2][1] == False, "gen1 cold before step 3"

        # 4. gen2 is cold during its 6 warmup steps
        gen2_calls = [x for x in call_log if x[0] == 2]
        first_6_gen2 = gen2_calls[:6]
        assert len(first_6_gen2) == 6, (
            "gen2 should get exactly 6 warmup steps, got %d" % len(first_6_gen2)
        )
        assert all(not w for _, w in first_6_gen2), (
            "gen2 should be cold during its warmup steps"
        )

        # 5. After gen2's 6 warmup steps, all remaining steps are warm
        # gen1 got 3 warmup, gen2 got 6 warmup, then round-robin starts
        # Total calls = 3 (gen1 warmup) + 6 (gen2 warmup) + round-robin
        warm_start = 3 + 6
        warmed_steps = call_log[warm_start:]
        if len(warmed_steps) > 0:
            assert all(w for _, w in warmed_steps), (
                "All steps after warmup should have warmed_up=True"
            )
            # First warm round-robin pair: gen1, gen2
            if len(warmed_steps) >= 2:
                assert warmed_steps[0][0] == 1 and warmed_steps[1][0] == 2, (
                    "Round-robin should start with gen1 then gen2"
                )

        # --- Summary ---
        step_order_str = " ".join(
            "1" if g == 1 else "2" for g, _ in call_log
        )
        total_gen1 = len(gen1_calls)
        total_gen2 = len(gen2_calls)
        warm_gen1 = sum(1 for _, w in gen1_calls if w)
        warm_gen2 = sum(1 for _, w in gen2_calls if w)

        print(f"  Step order: {step_order_str}")
        print(f"  gen1: {total_gen1} steps ({total_gen1 - warm_gen1} warmup, {warm_gen1} warm)")
        print(f"  gen2: {total_gen2} steps ({total_gen2 - warm_gen2} warmup, {warm_gen2} warm)")
        print(f"  Round-robin after warmup: {len(warmed_steps)} steps")
        print("  PASS: Staggered warmup loop — exclusive then round-robin")
        return True


async def main():
    print("Kyutai TTS Streaming Server Integration Tests")
    print("=" * 50)
    print(f"Connecting to {SERVER_URL}...")
    print()

    tests = [
        ("basic_stream", test_basic_stream),
        ("incremental_text", test_incremental_text),
        ("invalid_voice", test_invalid_voice),
        ("stop", test_stop),
        ("concurrent_streams", test_concurrent_streams),
        ("unknown_message_type", test_unknown_message_type),
        ("stop_no_stream", test_stop_no_stream),
        # Unit tests (no server needed)
        ("cache_isolation", test_cache_isolation),
        ("padding_frame_handling", test_padding_frame_handling),
        ("warmup_flag", test_warmup_flag),
        ("staggered_warmup_loop", test_staggered_warmup_loop),
    ]

    results = {}
    for name, test_fn in tests:
        print(f"Test: {name}")
        try:
            results[name] = await test_fn()
        except Exception as e:
            print(f"  FAIL: Crashed: {e}")
            results[name] = False

    print()
    print("=" * 50)
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    print(f"Results: {passed}/{total} tests passed")

    if passed == total:
        print("All tests passed!")
        sys.exit(0)
    else:
        failed = [k for k, v in results.items() if not v]
        print(f"Failed: {failed}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
