import hashlib
import hmac
import importlib.util
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest
import wave

from upload_benchmark import Client, HttpFailure, checked_location, payload, terminal_result, summarize
from upload_benchmark_audit import decrypt_strongbox
import upload_benchmark_recover as recover


class BenchmarkContracts(unittest.TestCase):
    def test_full_audio_pending_after_patch_failure_can_finish_without_retransmission(self):
        requests = []
        response = {"status": 204, "offset": "16044"}

        class PendingAudio(BaseHTTPRequestHandler):
            def do_PATCH(self):
                requests.append((self.path, self.headers.get("Upload-Offset"), self.rfile.read(int(self.headers.get("Content-Length", "0")))))
                self.send_response(response["status"])
                self.send_header("Upload-Offset", response["offset"])
                self.end_headers()

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), PendingAudio)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            row = {"kind": "audio", "bytes": 16044}
            recover.finish_pending_audio(Client(f"http://127.0.0.1:{server.server_port}"), "/upload/1", row)
            self.assertEqual(requests, [("/upload/1", "16044", b"")])
            self.assertEqual(row["tus_completion_http_status"], 204)
            response["offset"] = "16043"
            with self.assertRaises(RuntimeError):
                recover.finish_pending_audio(Client(f"http://127.0.0.1:{server.server_port}"), "/upload/1", row)
            response["status"] = 503
            with self.assertRaises(HttpFailure):
                recover.finish_pending_audio(Client(f"http://127.0.0.1:{server.server_port}"), "/upload/1", row)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_upload_location_cannot_send_session_to_another_host(self):
        self.assertEqual(checked_location("http://127.0.0.1:1234/upload/1", "http://127.0.0.1:1234"), "/upload/1")
        for location in ("http://evil.test/upload", "//evil.test/upload", "ftp://127.0.0.1:1234/upload"):
            with self.assertRaises(ValueError):
                checked_location(location, "http://127.0.0.1:1234")

    def test_accepted_is_not_completed(self):
        self.assertIsNone(terminal_result({"status": "queued"}))
        self.assertIsNone(terminal_result({"status": "processing"}))
        self.assertEqual(terminal_result({"status": "completed", "result": {"audio": {"id": "1"}}}), {"audio": {"id": "1"}})
        with self.assertRaises(RuntimeError):
            terminal_result({"status": "failed", "error": {"code": "invalid_audio"}})
        with self.assertRaises(ValueError):
            terminal_result({"status": "completed", "result": None})

    def test_failed_samples_are_counted_without_success_throughput(self):
        rows = [{"ok": True, "bytes": 1048576, "ack_seconds": 0.1, "publication_seconds": 2.0},
                {"ok": False, "bytes": 1048576, "error": "HTTP 503"}]
        result = summarize(rows, 4)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["succeeded"], 1)
        self.assertEqual(result["mib_per_second"], 0.25)
        self.assertEqual(result["publication_seconds"]["p95"], 2.0)
        self.assertEqual(result["ack_seconds"]["p95"], 0.1)

    def test_audio_payload_is_valid_and_unique(self):
        first = payload("audio", 16044, b"first")
        second = payload("audio", 16044, b"second")
        self.assertNotEqual(hashlib.sha256(first).digest(), hashlib.sha256(second).digest())
        with wave.open(io.BytesIO(first), "rb") as wav:
            self.assertEqual((wav.getnchannels(), wav.getframerate(), wav.getnframes()), (1, 8000, 8000))

    def test_redirect_cannot_forward_session_cookie(self):
        received = []

        class Target(BaseHTTPRequestHandler):
            def do_GET(self):
                received.append(self.headers.get("Cookie"))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *_):
                pass

        target = ThreadingHTTPServer(("127.0.0.1", 0), Target)

        class Redirect(Target):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{target.server_port}/stolen")
                self.end_headers()

        origin = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        threads = [threading.Thread(target=server.serve_forever) for server in (origin, target)]
        for thread in threads:
            thread.start()
        try:
            client = Client(f"http://127.0.0.1:{origin.server_port}", "id=test-session")
            with self.assertRaises(HttpFailure) as error:
                client.request("/redirect", method="GET")
            self.assertEqual(error.exception.status, 302)
            self.assertEqual(received, [])
        finally:
            for server in (origin, target):
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join()

    @unittest.skipUnless(importlib.util.find_spec("cryptography"), "Run with the audit venv to check decryption")
    def test_audit_authenticates_payload_and_storage_context(self):
        from cryptography.exceptions import InvalidTag
        from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
        key, nonce, context = bytes(range(32)), bytes(range(12)), b"bucket/object"
        kid = hmac.digest(key, b"key_id\x01", "sha256")[:16]
        body = ChaCha20Poly1305(key).encrypt(nonce, b"original bytes", context + kid + nonce)
        envelope = bytes.fromhex("b1b8f58350") + kid + b"\x4c" + nonce + b"\x58" + bytes([len(body)]) + body
        self.assertEqual(decrypt_strongbox(envelope, key, context.decode()), b"original bytes")
        with self.assertRaises(InvalidTag):
            decrypt_strongbox(envelope, key, "bucket/another-object")
        with self.assertRaises(InvalidTag):
            decrypt_strongbox(envelope[:-1] + bytes([envelope[-1] ^ 1]), key, context.decode())


if __name__ == "__main__":
    unittest.main()
