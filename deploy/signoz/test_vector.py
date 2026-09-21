#!/usr/bin/env python3
import argparse
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


def check(vector, config, directory, name, enabled, endpoint):
    env = os.environ.copy()
    env.pop("SIGNOZ_LOGS_ENABLED", None)
    env.pop("SIGNOZ_LOGS_ENDPOINT", None)
    if enabled is not None:
        env["SIGNOZ_LOGS_ENABLED"] = enabled
    if endpoint is not None:
        env["SIGNOZ_LOGS_ENDPOINT"] = endpoint
    expected = FORWARDED if enabled == "true" and endpoint else DROPPED
    path = directory / f"{name}.yaml"
    path.write_text(config + f"\ntests:\n  - name: {name}\n" + INPUT + expected)
    for command in (
        [vector, "validate", "--no-environment", str(path)],
        [vector, "test", str(path)],
    ):
        subprocess.run(command, env=env, check=True, timeout=30)


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


if __name__ == "__main__":
    main()
