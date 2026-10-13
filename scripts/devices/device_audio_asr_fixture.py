#!/usr/bin/env python3
"""Loopback fixture for the pinned echo-gpu upload/guess protocol; not a real ASR."""

import argparse
import email.policy
import hashlib
import hmac
import http.server
import json
import socket
import threading
import time
import uuid
from email.parser import BytesParser
from pathlib import Path

MODES = {"success", "no_speech", "safe_rejection", "overloaded", "proxy_unavailable", "delayed", "lost_response", "chunk_error"}
MAX_UPLOAD = 101 * 1024 * 1024


class Fixture:
    def __init__(self, token):
        self.token = token
        self.lock = threading.Lock()
        self.audio = {}
        self.checksums = {}
        self.control = {"mode": "success", "delay_seconds": 0.1, "fail_on_guess": 2}
        self.mode_guesses = 0
        self.counters = {"uploads": 0, "guess_requests": 0, "inferences": 0, "active": 0,
                         "completed": 0, "max_active": 0}
        self.events = []

    def configure(self, control):
        if (set(control) - {"mode", "delay_seconds", "fail_on_guess", "overload_status", "retry_after"} or
                control.get("mode", "success") not in MODES or
                not 0 <= float(control.get("delay_seconds", 0.1)) <= 300 or
                control.get("overload_status", 503) not in (429, 503) or
                (control.get("retry_after") is not None and
                 (not isinstance(control["retry_after"], int) or not 0 <= control["retry_after"] <= 3600)) or
                not isinstance(control.get("fail_on_guess", 2), int) or control.get("fail_on_guess", 2) < 1):
            raise ValueError("Invalid bounded fixture control")
        with self.lock:
            self.control = {"mode": "success", "delay_seconds": 0.1, "fail_on_guess": 2, **control}
            self.mode_guesses = 0

    def begin(self, audio_id):
        with self.lock:
            self.counters["guess_requests"] += 1
            self.mode_guesses += 1
            control = dict(self.control)
            control["ordinal"] = self.mode_guesses
            if audio_id not in self.audio or control["mode"] == "safe_rejection":
                return None
            if control["mode"] == "overloaded":
                return control
            self.counters["inferences"] += 1
            self.counters["active"] += 1
            self.counters["max_active"] = max(self.counters["max_active"], self.counters["active"])
            self.events.append({"audio_id": audio_id, "event": "started", "at": time.monotonic()})
            return control

    def finish(self, audio_id):
        with self.lock:
            self.counters["active"] -= 1
            self.counters["completed"] += 1
            self.events.append({"audio_id": audio_id, "event": "completed", "at": time.monotonic()})


def handler(fixture, role):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, value, content_type="application/json", retry_after=None):
            body = json.dumps(value, ensure_ascii=False).encode() if content_type == "application/json" else value.encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            if retry_after is not None:
                self.send_header("Retry-After", str(retry_after))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def authorized(self):
            return hmac.compare_digest(self.headers.get("X-Fixture-Token", ""), fixture.token)

        def do_GET(self):
            if self.path == "/":
                self.reply(200, "pong" if role == "rust" else "alive", "text/plain")
            elif self.path == "/__fixture/state" and self.authorized():
                with fixture.lock:
                    self.reply(200, {**fixture.counters, "events": list(fixture.events)})
            else:
                self.reply(403 if self.path.startswith("/__fixture/") else 404, {"error": "unavailable"})

        def body(self):
            limit = MAX_UPLOAD if self.path == "/api/v1/audio/upload" else 4096
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > limit or self.headers.get("Transfer-Encoding"):
                raise ValueError("Bounded Content-Length is required")
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("Incomplete request")
            return body

        def do_POST(self):
            self.connection.settimeout(10)
            if self.path.startswith("/__fixture/") and not self.authorized():
                self.reply(403, {"error": "unavailable"})
                return
            try:
                body = self.body()
                if self.path == "/__fixture/control":
                    fixture.configure(json.loads(body))
                    self.reply(200, {"ok": True})
                elif role == "rust" and self.path == "/api/v1/audio/upload":
                    self.upload(body)
                elif role == "rust" and self.path == "/api/v1/audio/get":
                    with fixture.lock:
                        audio_id = fixture.checksums.get(json.loads(body)["sha256"])
                    self.reply(200 if audio_id else 404, {"uuid": audio_id})
                elif role == "python" and self.path == "/api/guess":
                    request = json.loads(body)
                    if not isinstance(request["message"], str):
                        raise ValueError("message must be a string")
                    self.guess(str(uuid.UUID(request["audio_id"])))
                else:
                    self.reply(404, {"error": "unknown route"})
            except (ValueError, KeyError, TypeError):
                self.reply(400, {"error": "malformed fixture request"})

        def upload(self, body):
            header = f"Content-Type: {self.headers.get('Content-Type', '')}\r\nMIME-Version: 1.0\r\n\r\n".encode()
            message = BytesParser(policy=email.policy.default).parsebytes(header + body)
            files = [part for part in message.iter_parts() if part.get_param("name", header="content-disposition") == "file"]
            if len(files) != 1:
                raise ValueError("One multipart file required")
            content = files[0].get_payload(decode=True)
            if not content:
                raise ValueError("Empty audio")
            checksum = hashlib.sha256(content).hexdigest()
            with fixture.lock:
                audio_id = fixture.checksums.setdefault(checksum, str(uuid.uuid4()))
                fixture.audio[audio_id] = files[0].get_filename() or "audio.wav"
                fixture.counters["uploads"] += 1
            self.reply(200, {"uuid": audio_id})

        def guess(self, audio_id):
            control = fixture.begin(audio_id)
            if control is None:
                self.reply(404, {"error": "audio not ready; inference not started"})
                return
            if control["mode"] == "overloaded":
                self.reply(control.get("overload_status", 503), {"error": "overloaded", "detail": "inference capacity unavailable"},
                           retry_after=control.get("retry_after"))
                return
            try:
                if control["mode"] == "proxy_unavailable":
                    self.reply(503, "upstream unavailable", "text/plain", retry_after=1)
                    time.sleep(float(control["delay_seconds"]))
                    return
                if control["mode"] in ("delayed", "lost_response"):
                    time.sleep(float(control["delay_seconds"]))
            finally:
                fixture.finish(audio_id)
            if control["mode"] == "lost_response":
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            if control["mode"] == "chunk_error" and control["ordinal"] == control["fail_on_guess"]:
                self.reply(500, {"error": "injected later chunk failure"})
                return
            text = "" if control["mode"] == "no_speech" else "Автоматична транскрипція"
            segments = [] if not text else [{"i": 0, "start": 0.0, "end": 1.0, "text": text,
                "conf": None, "avg_logprob": -0.1, "no_speech_prob": 0.0,
                "metadata": {"filename": fixture.audio[audio_id], "lang": "uk", "langprob": 1.0, "duration": 1.0}}]
            self.reply(200, {"audio_id": audio_id, "full_phrase": text, "segments": segments})

    return Handler


def serve(rs_port, py_port, token):
    fixture = Fixture(token)
    rust = http.server.ThreadingHTTPServer(("127.0.0.1", rs_port), handler(fixture, "rust"))
    python = http.server.ThreadingHTTPServer(("127.0.0.1", py_port), handler(fixture, "python"))
    threading.Thread(target=rust.serve_forever, daemon=True).start()
    python.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rs-port", type=int, required=True)
    parser.add_argument("--py-port", type=int, required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    args = parser.parse_args()
    serve(args.rs_port, args.py_port, args.token_file.read_text())
