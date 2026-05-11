"""
Standalone integration test for the Kyutai TTS WebSocket server.

Usage:
    # Start the server in another terminal first:
    python server/tts-server.py

    # Then run this test:
    python server/test_server.py

Tests:
    1. Synthesize "Hello world" → receive non-silent PCM frames + "done"
    2. Invalid voice → receive error message
    3. Empty text → receive error message
"""

import asyncio
import json
import sys
from websockets.asyncio.client import connect

SERVER_URL = "ws://localhost:8765"


async def test_synthesize():
    """Send a synthesize request and verify non-silent PCM frames are received."""
    async with connect(SERVER_URL) as ws:
        # Send synthesize request
        await ws.send(json.dumps({
            "type": "synthesize",
            "text": "Hello world",
            "voice": "alba-mackenna/casual.wav",
        }))

        pcm_frames = []
        all_silent = True

        async for message in ws:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "pcm":
                pcm = data.get("data", [])
                pcm_frames.append(pcm)
                # Check if any sample is non-zero (non-silent)
                if any(abs(s) > 1e-6 for s in pcm):
                    all_silent = False

            elif msg_type == "done":
                break

            elif msg_type == "error":
                print(f"FAIL: Unexpected error: {data.get('message')}")
                return False

    if len(pcm_frames) == 0:
        print("FAIL: No PCM frames received")
        return False

    if all_silent:
        print("FAIL: All PCM frames are silent (all zeros)")
        return False

    print(f"PASS: Synthesize — received {len(pcm_frames)} PCM frames, "
          f"{'non-silent' if not all_silent else 'SILENT'} audio")
    return True


async def test_invalid_voice():
    """Send a synthesize request with an invalid voice and verify error."""
    async with connect(SERVER_URL) as ws:
        await ws.send(json.dumps({
            "type": "synthesize",
            "text": "Hello world",
            "voice": "nonexistent_voice_xyz",
        }))

        async for message in ws:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "error":
                err_msg = data.get("message", "")
                print(f"PASS: Invalid voice — received error: {err_msg[:80]}...")
                return True

            elif msg_type == "pcm":
                print("FAIL: Received PCM for invalid voice (expected error)")
                return False

            elif msg_type == "done":
                print("FAIL: Received done for invalid voice (expected error)")
                return False

    print("FAIL: Connection closed without error for invalid voice")
    return False


async def test_empty_text():
    """Send a synthesize request with empty text and verify error."""
    async with connect(SERVER_URL) as ws:
        await ws.send(json.dumps({
            "type": "synthesize",
            "text": "",
            "voice": "alba-mackenna/casual.wav",
        }))

        async for message in ws:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "error":
                print(f"PASS: Empty text — received error")
                return True

            elif msg_type == "pcm":
                print("FAIL: Received PCM for empty text (expected error)")
                return False

            elif msg_type == "done":
                print("FAIL: Received done for empty text (expected error)")
                return False

    print("FAIL: Connection closed without error for empty text")
    return False


async def test_unknown_message_type():
    """Send an unknown message type and verify error."""
    async with connect(SERVER_URL) as ws:
        await ws.send(json.dumps({
            "type": "unknown_command",
        }))

        async for message in ws:
            data = json.loads(message)
            msg_type = data.get("type")

            if msg_type == "error":
                print(f"PASS: Unknown message type — received error")
                return True

            elif msg_type == "pcm":
                print("FAIL: Received PCM for unknown command")
                return False

    print("FAIL: Connection closed without error for unknown command")
    return False


async def main():
    print("Kyutai TTS Server Integration Tests")
    print("=" * 50)
    print(f"Connecting to {SERVER_URL}...")
    print()

    results = {}

    # Test 1: Successful synthesis
    try:
        results["synthesize"] = await test_synthesize()
    except Exception as e:
        print(f"FAIL: Synthesize test crashed: {e}")
        results["synthesize"] = False

    # Test 2: Invalid voice
    try:
        results["invalid_voice"] = await test_invalid_voice()
    except Exception as e:
        print(f"FAIL: Invalid voice test crashed: {e}")
        results["invalid_voice"] = False

    # Test 3: Empty text
    try:
        results["empty_text"] = await test_empty_text()
    except Exception as e:
        print(f"FAIL: Empty text test crashed: {e}")
        results["empty_text"] = False

    # Test 4: Unknown message type
    try:
        results["unknown_type"] = await test_unknown_message_type()
    except Exception as e:
        print(f"FAIL: Unknown type test crashed: {e}")
        results["unknown_type"] = False

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
