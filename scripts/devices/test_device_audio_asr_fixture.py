#!/usr/bin/env python3
"""Exercise the actual HTTP fixture's dispatch and uncertain-response boundaries."""

import hashlib
import http.client
import json
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import file_preview_harness as shared


class FixtureTest(unittest.TestCase):
    def setUp(self):
        script = Path(__file__).with_name("device_audio_asr_fixture.py")
        self.assertTrue(script.is_file(), "The controllable ASR fixture is missing")
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        token = Path(self.root.name) / "token"
        token.write_text("test-private-token")
        token.chmod(0o600)
        self.rs, self.py = shared.fresh_ports()[:2]
        self.process = subprocess.Popen([sys.executable, str(script), "--rs-port", str(self.rs),
                                         "--py-port", str(self.py), "--token-file", str(token)],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.stop)
        shared.wait_url(f"http://127.0.0.1:{self.rs}/", 5)

    def stop(self):
        self.process.terminate()
        self.process.wait(timeout=5)

    def request(self, path, data=None, port=None, token="test-private-token", timeout=2):
        request = urllib.request.Request(f"http://127.0.0.1:{port or self.rs}{path}",
            data=None if data is None else json.dumps(data).encode(),
            headers={"Content-Type": "application/json", "X-Fixture-Token": token})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout) as response:
            return json.load(response)

    def upload(self, audio=b"RIFF-audio-fixture"):
        body = (b'--test\r\nContent-Disposition: form-data; name="file_name"\r\n\r\nclip.wav\r\n'
                b'--test\r\nContent-Disposition: form-data; name="file"; filename="clip.wav"\r\n'
                b'Content-Type: audio/wav\r\n\r\n' + audio + b'\r\n--test--\r\n')
        request = urllib.request.Request(f"http://127.0.0.1:{self.rs}/api/v1/audio/upload", data=body,
                                         headers={"Content-Type": "multipart/form-data; boundary=test"})
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request) as response:
            return json.load(response)["uuid"]

    def guess(self, audio_id, timeout=2):
        return self.request("/api/guess", {"audio_id": audio_id, "message": ""}, self.py, timeout=timeout)

    def test_upload_lookup_and_safe_rejection_have_no_inference(self):
        audio_id = self.upload()
        self.assertEqual(self.request("/api/v1/audio/get", {"sha256": hashlib.sha256(b"RIFF-audio-fixture").hexdigest()}),
                         {"uuid": audio_id})
        self.request("/__fixture/control", {"mode": "safe_rejection"})
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.guess(audio_id)
        self.assertEqual(error.exception.code, 404)
        state = self.request("/__fixture/state")
        self.assertEqual((state["guess_requests"], state["inferences"], state["active"]), (1, 0, 0))
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/__fixture/control", {"mode": "success"}, token="foreign")
        self.assertEqual(error.exception.code, 403)

    def test_success_no_speech_and_later_chunk_error(self):
        audio_id = self.upload()
        response = self.guess(audio_id)
        self.assertEqual(response["audio_id"], audio_id)
        self.assertEqual(response["full_phrase"], "Автоматична транскрипція")
        self.assertEqual(response["segments"][0]["metadata"]["lang"], "uk")
        self.request("/__fixture/control", {"mode": "no_speech"})
        self.assertEqual(self.guess(audio_id)["full_phrase"], "")
        self.request("/__fixture/control", {"mode": "chunk_error", "fail_on_guess": 2})
        self.guess(audio_id)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.guess(audio_id)
        self.assertEqual(error.exception.code, 500)
        self.assertEqual(self.request("/__fixture/state")["inferences"], 4)

    def test_timeout_and_lost_response_remain_observable_after_disconnect(self):
        audio_id = self.upload()
        self.request("/__fixture/control", {"mode": "delayed", "delay_seconds": 0.5})
        with self.assertRaises(TimeoutError):
            self.guess(audio_id, timeout=0.05)
        self.assertEqual(self.request("/__fixture/state")["active"], 1)
        deadline = time.monotonic() + 3
        while self.request("/__fixture/state")["active"]:
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.02)
        self.request("/__fixture/control", {"mode": "lost_response", "delay_seconds": 0.05})
        with self.assertRaises(http.client.RemoteDisconnected):
            self.guess(audio_id)
        state = self.request("/__fixture/state")
        self.assertEqual((state["inferences"], state["completed"], state["active"]), (2, 2, 0))


if __name__ == "__main__":
    unittest.main()
