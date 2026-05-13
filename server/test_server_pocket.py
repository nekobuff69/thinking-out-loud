"""
Pocket TTS HTTP Server Tests.

Tests the Pocket TTS streaming HTTP server endpoints:
  - Health check
  - Voice listing (GET /v1/voices)
  - TTS generation with valid/invalid voices
  - Error message format (includes available voices)
  - Streaming WAV response validity

Mocks pocket_tts since the package requires PyTorch and model weights.
"""
import os
import sys
import importlib.util
import unittest
from unittest.mock import MagicMock

import numpy as np

# ---------------------------------------------------------------------------
# Mock pocket_tts before importing the server module
# ---------------------------------------------------------------------------

_mock_tts_instance = MagicMock()


def _mock_generate_audio_stream(text, voice_state=None):
    """Real generator yielding float32 numpy chunks."""
    yield np.array([0.1, 0.2, -0.1], dtype=np.float32)
    yield np.array([0.3, -0.2, 0.1], dtype=np.float32)


_mock_tts_instance.generate_audio_stream = _mock_generate_audio_stream
_mock_tts_instance.get_state_for_audio_prompt.return_value = "mock_voice_state"

_mock_tts_class = MagicMock(return_value=_mock_tts_instance)

# Assemble fake pocket_tts module
_mock_pocket_tts = MagicMock()
_mock_pocket_tts.TTS = _mock_tts_class
sys.modules["pocket_tts"] = _mock_pocket_tts

# Now import the server module
_server_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "tts-server-pocket.py")
_spec = importlib.util.spec_from_file_location("tts_server_pocket", _server_path)
_server_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_server_mod)

app = _server_mod.app

from fastapi.testclient import TestClient


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestPocketTTSServer(unittest.TestCase):
    """Integration-style tests for the Pocket TTS HTTP server."""

    @classmethod
    def setUpClass(cls):
        """Wire mock TTS instance and multiple voices into the server globals."""
        _server_mod._pocket_tts = _mock_tts_instance
        _server_mod._voices = {
            "default": "mock_voice_state_default",
            "alba-mackenna/casual": "mock_voice_state_casual",
            "alba-mackenna/merchant": "mock_voice_state_merchant",
        }

    def setUp(self):
        self.client = TestClient(app)

    # --- health ---

    def test_health_endpoint(self):
        """GET /health returns 200 OK with status payload."""
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["status"], "ok")

    # --- voice listing ---

    def test_list_voices(self):
        """GET /v1/voices returns a sorted list of available voice names."""
        response = self.client.get("/v1/voices")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("voices", data)
        self.assertIsInstance(data["voices"], list)
        self.assertIn("default", data["voices"],
                      "'default' voice must be present")
        self.assertIn("alba-mackenna/casual", data["voices"])
        self.assertIn("alba-mackenna/merchant", data["voices"])
        # Must be sorted
        self.assertEqual(data["voices"], sorted(data["voices"]))

    # --- TTS: valid voices ---

    def test_tts_endpoint_accepts_request(self):
        """POST /v1/tts with valid body returns 200 and audio/wav."""
        response = self.client.post("/v1/tts", json={
            "text": "hello",
            "voice": "default",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/wav")

    def test_tts_with_named_voice(self):
        """POST /v1/tts with a non-default valid voice returns 200."""
        response = self.client.post("/v1/tts", json={
            "text": "hello",
            "voice": "alba-mackenna/casual",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/wav")
        self.assertEqual(response.headers["x-voice"], "alba-mackenna/casual")

    # --- TTS: invalid voices ---

    def test_tts_endpoint_missing_fields(self):
        """POST /v1/tts with missing text or voice returns 400."""
        # Missing voice
        resp = self.client.post("/v1/tts", json={"text": "hello"})
        self.assertEqual(resp.status_code, 400)

        # Missing text
        resp = self.client.post("/v1/tts", json={"voice": "default"})
        self.assertEqual(resp.status_code, 400)

        # Empty body
        resp = self.client.post("/v1/tts", json={})
        self.assertEqual(resp.status_code, 400)

        # Text is null
        resp = self.client.post("/v1/tts", json={"text": None, "voice": "default"})
        self.assertEqual(resp.status_code, 400)

    def test_tts_endpoint_unknown_voice(self):
        """POST /v1/tts with unknown voice returns 400."""
        response = self.client.post("/v1/tts", json={
            "text": "hello",
            "voice": "nonexistent",
        })
        self.assertEqual(response.status_code, 400)

    def test_voice_not_found_message(self):
        """Error response for unknown voice includes the list of valid voices."""
        response = self.client.post("/v1/tts", json={
            "text": "hello",
            "voice": "bogus-voice",
        })
        self.assertEqual(response.status_code, 400)
        detail = response.json()["detail"]
        self.assertIn("Unknown voice: bogus-voice", detail)
        self.assertIn("Available voices:", detail)
        # Must list the voices we registered in setUpClass
        self.assertIn("default", detail)
        self.assertIn("alba-mackenna/casual", detail)
        self.assertIn("alba-mackenna/merchant", detail)

    # --- TTS: streaming audio validity ---

    def test_tts_streaming_response(self):
        """Response body is a valid WAV with streaming characteristics."""
        response = self.client.post("/v1/tts", json={
            "text": "hello world",
            "voice": "default",
        })
        self.assertEqual(response.status_code, 200)

        content = response.content
        self.assertGreater(len(content), 0, "Expected non-empty WAV response")

        # Valid WAV starts with RIFF header
        self.assertEqual(content[:4], b"RIFF",
                         f"Expected RIFF header, got {content[:4]!r}")
        # Next should be WAVE after the RIFF chunk size
        self.assertEqual(content[8:12], b"WAVE",
                         f"Expected WAVE marker, got {content[8:12]!r}")


if __name__ == "__main__":
    unittest.main()
