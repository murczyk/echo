#!/usr/bin/env python3
"""Run tests with disposable local S3, upload storage and an inherited DB config."""

import base64
import logging
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import tempfile

import boto3
from moto.server import ThreadedMotoServer
import toml


def write_config(root, endpoint):
    repository = Path(__file__).resolve().parents[2]
    source = Path(os.environ.get("ECHO_CONFIG_PATH", repository / "deploy/config-test.toml"))
    config = toml.load(source)
    storage = root / "storage"
    storage.mkdir()
    config["storage_dir"] = str(storage)
    config["s3_config"] = {
        "s3_access_key_id": "echo-test-access",
        "s3_secret_access_key": secrets.token_hex(32),
        "s3_endpoint": endpoint,
        "s3_region": "us-east-1",
        "s3_bucket": "device-audio-" + secrets.token_hex(12),
        "strongbox_key": base64.b64encode(secrets.token_bytes(32)).decode("ascii"),
    }
    s3 = config["s3_config"]
    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=s3["s3_region"],
        aws_access_key_id=s3["s3_access_key_id"],
        aws_secret_access_key=s3["s3_secret_access_key"],
    )
    client.create_bucket(Bucket=s3["s3_bucket"])
    path = root / "config.toml"
    path.touch(mode=0o600)
    path.write_text(toml.dumps(config))
    return path


def run_command(command, environment):
    process = subprocess.Popen(command, env=environment, start_new_session=True)

    def forward_signal(number, _frame):
        try:
            os.killpg(process.pid, number)
        except ProcessLookupError:
            pass

    handlers = {
        number: signal.signal(number, forward_signal)
        for number in (signal.SIGTERM, signal.SIGINT)
    }
    try:
        status = process.wait()
        return status if status >= 0 else 128 - status
    finally:
        for number, handler in handlers.items():
            signal.signal(number, handler)
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: with_test_storage.sh <command> [args...]")
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    with tempfile.TemporaryDirectory(prefix="echo-device-audio.", dir="/tmp") as directory:
        root = Path(directory)
        server.start()
        try:
            host, port = server.get_host_and_port()
            config = write_config(root, f"http://{host}:{port}")
            environment = os.environ.copy()
            environment.update(ECHO_CONFIG_PATH=str(config), AUDIO_TEST_ROOT=str(root))
            print(f"Using isolated test storage: {root}", flush=True)
            return run_command(sys.argv[1:], environment)
        finally:
            server.stop()


if __name__ == "__main__":
    sys.exit(main())
