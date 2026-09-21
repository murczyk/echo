#!/usr/bin/env python3
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile


INPUT = """
    inputs:
      - insert_at: parse_logs
        type: log
        log_fields:
          message: "AI bootstrap diagnostic fixture"
          host: "ct-echo-cbr"
          _SYSTEMD_UNIT: "wdintel-rs.service"
          _signoz_logs_endpoint: "http://untrusted.invalid"
"""
FORWARDED = """
    outputs:
      - extract_from: signoz_prepare
        conditions:
          - type: vrl
            source: >-
              .resources."host.name" == "ct-echo-cbr" &&
              .resources."service.name" == "wdintel-rs" &&
              ._signoz_logs_endpoint == "http://127.0.0.1:8082"
"""
DROPPED = """
    no_outputs_from:
      - signoz_filter
"""


def vector_environment(enabled, endpoint):
    env = os.environ.copy()
    env["VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION"] = "true"
    env.pop("SIGNOZ_LOGS_ENABLED", None)
    env.pop("SIGNOZ_LOGS_ENDPOINT", None)
    if enabled is not None:
        env["SIGNOZ_LOGS_ENABLED"] = enabled
    if endpoint is not None:
        env["SIGNOZ_LOGS_ENDPOINT"] = endpoint
    return env


def check(vector, config, directory, name, enabled, endpoint):
    env = vector_environment(enabled, endpoint)
    expected = FORWARDED if enabled == "true" and endpoint else DROPPED
    path = directory / f"{name}.yaml"
    path.write_text(config + f"\ntests:\n  - name: {name}\n" + INPUT + expected)
    for command in (
        [vector, "validate", "--no-environment", str(path)],
        [vector, "test", str(path)],
    ):
        subprocess.run(command, env=env, check=True, timeout=30)


class Receiver(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.received.append(json.loads(body))
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *_):
        pass


def check_delivery(vector, config, directory):
    config = config.replace("enabled: true", "enabled: false", 1)
    config = config.replace(
        "type: journald\n    since_now: true",
        "type: stdin\n    decoding:\n      codec: json",
    ).replace(
        "/var/lib/postgresql/18/main/log/postgresql-*.log",
        str(directory / "no-logs.log"),
    )
    path = directory / "delivery.yaml"
    path.write_text(f"data_dir: {json.dumps(str(directory))}\n" + config)
    with HTTPServer(("127.0.0.1", 0), Receiver) as receiver:
        receiver.timeout = 15
        receiver.received = []
        env = vector_environment("true", f"http://127.0.0.1:{receiver.server_port}")
        process = subprocess.Popen(
            [vector, "--config", str(path)], env=env, text=True,
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        try:
            process.stdin.write(json.dumps({
                "message": "AI bootstrap delivery fixture", "host": "ct-echo-cbr",
                "_SYSTEMD_UNIT": "wdintel-rs.service",
                "_signoz_logs_endpoint": "http://untrusted.invalid",
            }) + "\n")
            process.stdin.flush()
            receiver.handle_request()
        finally:
            process.terminate()
            try:
                _, stderr = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                _, stderr = process.communicate()
        assert receiver.received, f"Vector did not deliver the fixture:\n{stderr}"
        events = receiver.received[0]
        event = events[0] if isinstance(events, list) else events
        assert event["resources"]["host.name"] == "ct-echo-cbr"
        assert event["resources"]["service.name"] == "wdintel-rs"
        assert "_signoz_logs_endpoint" not in event
        print("HTTP delivery ... passed")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vector", default="vector")
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("vector.yaml"))
    args = parser.parse_args()
    config = args.config.read_text()
    with tempfile.TemporaryDirectory(prefix="echo-vector-test-") as directory:
        for name, enabled, endpoint in (
            ("enabled", "true", "http://127.0.0.1:8082"),
            ("disabled", "false", "http://127.0.0.1:8082"),
            ("empty-endpoint", "true", ""),
            ("unset-endpoint", "true", None),
            ("unset-settings", None, None),
        ):
            check(args.vector, config, Path(directory), name, enabled, endpoint)
        check_delivery(args.vector, config, Path(directory))


if __name__ == "__main__":
    main()
