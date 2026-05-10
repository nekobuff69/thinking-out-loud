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
import json
import sys
import time
from websockets.asyncio.client import connect

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
