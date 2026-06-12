#!/usr/bin/env python3

import argparse
import base64
import binascii
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path


ENV_PATH = Path(__file__).with_name(".env")
REQUIRED_ENV = (
    "IGGY_HTTP_URL",
    "IGGY_USERNAME",
    "IGGY_PASSWORD",
    "IGGY_STREAM",
    "IGGY_INBOX_TOPIC",
    "IGGY_ANALYTICS_TOPIC",
)


class TestError(Exception):
    pass


def load_env() -> None:
    if not ENV_PATH.exists():
        raise TestError(f"Missing {ENV_PATH}. Copy .env.example to .env and fill it in.")

    lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    for line_number, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            raise TestError(f"Invalid .env line {line_number}: expected KEY=VALUE")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key, value)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise TestError(f"Missing required environment variable: {name}")
    return value


def positive_number(name: str, default: str, number_type):
    value = os.environ.get(name, default)
    try:
        parsed = number_type(value)
    except ValueError as error:
        raise TestError(f"{name} must be a number, got: {value}") from error
    if parsed <= 0:
        raise TestError(f"{name} must be greater than zero")
    return parsed


class IggyHttpClient:
    def __init__(self) -> None:
        for name in REQUIRED_ENV:
            required_env(name)
        self.base_url = required_env("IGGY_HTTP_URL").rstrip("/")
        self.username = required_env("IGGY_USERNAME")
        self.password = required_env("IGGY_PASSWORD")
        self.stream = required_env("IGGY_STREAM")
        self.timeout = positive_number("IGGY_TIMEOUT_SECONDS", "10", float)
        self.poll_attempts = positive_number("IGGY_POLL_ATTEMPTS", "5", int)
        self.poll_delay = positive_number("IGGY_POLL_DELAY_SECONDS", "1", float)
        self.token = ""

    def login(self) -> None:
        response = self.request(
            "POST",
            "/users/login",
            {"username": self.username, "password": self.password},
            authenticated=False,
        )
        access_token = response.get("access_token") or {}
        self.token = access_token.get("token", "")
        if not self.token:
            raise TestError("Iggy login response did not contain an access token")

    def request(
        self,
        method: str,
        path: str,
        body=None,
        query=None,
        authenticated: bool = True,
    ):
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        if authenticated:
            if not self.token:
                raise TestError("Iggy client is not authenticated")
            headers["Authorization"] = f"Bearer {self.token}"

        request = urllib.request.Request(
            url, data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read()
        except urllib.error.HTTPError as error:
            details = error.read().decode("utf-8", errors="replace")
            raise TestError(
                f"{method} {url} failed with HTTP {error.code}: {details}"
            ) from error
        except urllib.error.URLError as error:
            raise TestError(f"{method} {url} failed: {error.reason}") from error

        if not payload:
            return {}
        try:
            return json.loads(payload)
        except json.JSONDecodeError as error:
            raise TestError(f"{method} {url} returned invalid JSON") from error

    def topic_path(self, topic: str) -> str:
        stream = urllib.parse.quote(self.stream, safe="")
        topic = urllib.parse.quote(topic, safe="")
        return f"/streams/{stream}/topics/{topic}"

    def require_topic(self, topic: str) -> None:
        response = self.request("GET", self.topic_path(topic))
        if response.get("name") != topic:
            raise TestError(f"Iggy returned unexpected topic data for {topic}")

    def publish_and_verify(self, topic: str) -> None:
        marker = str(uuid.uuid4())
        event = {
            "test_id": marker,
            "topic": topic,
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "source": "echo-iggy/test-cli",
        }
        payload = base64.b64encode(
            json.dumps(event, separators=(",", ":")).encode("utf-8")
        ).decode("ascii")
        self.request(
            "POST",
            f"{self.topic_path(topic)}/messages",
            {
                "partitioning": {"kind": "balanced", "value": ""},
                "messages": [{"id": marker, "payload": payload}],
            },
        )

        for attempt in range(self.poll_attempts):
            response = self.request(
                "GET",
                f"{self.topic_path(topic)}/messages",
                query={
                    "consumer_id": f"echo-test-{marker}",
                    "partition_id": 0,
                    "kind": "last",
                    "value": 0,
                    "count": 100,
                    "auto_commit": "false",
                },
            )
            messages = response.get("messages", [])
            if any(self.message_has_marker(message, marker) for message in messages):
                print(f"PASS: published and read test event from {self.stream}/{topic}")
                return
            if attempt + 1 < self.poll_attempts:
                time.sleep(self.poll_delay)

        raise TestError(
            f"Published test event was not found in {self.stream}/{topic}"
        )

    @staticmethod
    def message_has_marker(message, marker: str) -> bool:
        encoded_payload = message.get("payload", "")
        try:
            payload = base64.b64decode(encoded_payload).decode("utf-8")
            event = json.loads(payload)
        except (binascii.Error, ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return False
        return isinstance(event, dict) and event.get("test_id") == marker


def connected_client() -> IggyHttpClient:
    client = IggyHttpClient()
    client.login()
    return client


def check() -> None:
    client = connected_client()
    stream = urllib.parse.quote(client.stream, safe="")
    client.request("GET", f"/streams/{stream}")
    client.require_topic(required_env("IGGY_INBOX_TOPIC"))
    client.require_topic(required_env("IGGY_ANALYTICS_TOPIC"))
    print("PASS: Iggy is responsive and both configured topics exist")


def test_inbox() -> None:
    connected_client().publish_and_verify(required_env("IGGY_INBOX_TOPIC"))


def test_analytics() -> None:
    connected_client().publish_and_verify(required_env("IGGY_ANALYTICS_TOPIC"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Test an Apache Iggy HTTP server")
    parser.add_argument(
        "command",
        choices=("check", "test-inbox", "test-analytics"),
    )
    args = parser.parse_args()

    try:
        load_env()
        {
            "check": check,
            "test-inbox": test_inbox,
            "test-analytics": test_analytics,
        }[args.command]()
    except TestError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
