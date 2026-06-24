#!/usr/bin/env python3

import argparse
import asyncio
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
TOPIC_ENV = (
    "IGGY_STREAM",
    "IGGY_INBOX_TOPIC",
    "IGGY_ANALYTICS_TOPIC",
)
HTTP_ENV = (
    "IGGY_HTTP_URL",
    "IGGY_USERNAME",
    "IGGY_PASSWORD",
    *TOPIC_ENV,
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
        for name in HTTP_ENV:
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

    def publish_random(self, topic: str):
        marker = str(uuid.uuid4())
        event = {
            "test_id": marker,
            "topic": topic,
            "sent_at": datetime.now(timezone.utc).isoformat(),
            "source": "echo-iggy/test-cli",
        }
        print(f"Sent payload: {json.dumps(event, ensure_ascii=False)}")
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
        return event

    def publish_and_verify(self, topic: str) -> None:
        event = self.publish_random(topic)
        marker = event["test_id"]
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
            received_event = self.find_event(messages, marker)
            if received_event is not None:
                print(
                    "Received payload: "
                    f"{json.dumps(received_event, ensure_ascii=False)}"
                )
                print(f"PASS: published and read test event from {self.stream}/{topic}")
                return
            if attempt + 1 < self.poll_attempts:
                time.sleep(self.poll_delay)

        raise TestError(
            f"Published test event was not found in {self.stream}/{topic}"
        )

    def print_new(self, topic: str) -> None:
        self.require_topic(topic)
        consumer_id = uuid.uuid5(
            uuid.NAMESPACE_URL, f"echo-iggy/test-cli/{self.stream}/{topic}"
        )
        printed = 0
        while True:
            response = self.request(
                "GET",
                f"{self.topic_path(topic)}/messages",
                query={
                    "consumer_id": f"echo-test-cli-{consumer_id}",
                    "partition_id": 0,
                    "kind": "next",
                    "value": 0,
                    "count": 100,
                    "auto_commit": "true",
                },
            )
            messages = response.get("messages", [])
            if not messages:
                break
            for message in messages:
                print(f"Received payload: {self.format_payload(message)}")
                printed += 1

        print(f"Read {printed} new message(s) from {self.stream}/{topic}")

    @staticmethod
    def find_event(messages, marker: str):
        for message in messages:
            event = IggyHttpClient.decode_event(message)
            if isinstance(event, dict) and event.get("test_id") == marker:
                return event
        return None

    @staticmethod
    def decode_payload(message):
        try:
            return base64.b64decode(message.get("payload", ""), validate=True)
        except (binascii.Error, ValueError):
            return None

    @staticmethod
    def decode_event(message):
        payload = IggyHttpClient.decode_payload(message)
        if payload is None:
            return None
        try:
            return json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    @staticmethod
    def format_payload(message) -> str:
        payload = IggyHttpClient.decode_payload(message)
        if payload is None:
            return "<invalid base64 payload>"
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError:
            return f"<base64:{base64.b64encode(payload).decode('ascii')}>"
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            return text
        return json.dumps(value, ensure_ascii=False)


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


def send(topic: str) -> None:
    connected_client().publish_random(topic)


def print_new(topic: str) -> None:
    connected_client().print_new(topic)


def default_tcp_url() -> str:
    http_url = os.environ.get("IGGY_HTTP_URL", "").strip()
    if not http_url:
        return "iggy://127.0.0.1:8090"

    parsed = urllib.parse.urlsplit(http_url)
    if not parsed.hostname:
        return "iggy://127.0.0.1:8090"

    host = parsed.hostname
    if ":" in host:
        host = f"[{host}]"
    return f"iggy://{host}:8090"


def native_connection_string() -> str:
    connection_string = os.environ.get("IGGY_CONNECTION_STRING", "").strip()
    if connection_string:
        return connection_string

    return connection_string_from_url(
        os.environ.get("IGGY_TCP_URL", "").strip() or default_tcp_url(),
        required_env("IGGY_USERNAME"),
        required_env("IGGY_PASSWORD"),
    )


def connection_string_from_url(url: str, username: str, password: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if not parsed.scheme or not parsed.hostname:
        raise TestError(f"Invalid IGGY_TCP_URL: {url}")

    host = parsed.hostname
    if ":" in host:
        host = f"[{host}]"
    try:
        port = parsed.port
    except ValueError as error:
        raise TestError(f"Invalid IGGY_TCP_URL port: {url}") from error
    host = f"{host}:{port}" if port is not None else host

    username = urllib.parse.quote(username, safe="")
    password = urllib.parse.quote(password, safe="")
    return urllib.parse.urlunsplit(
        (
            parsed.scheme,
            f"{username}:{password}@{host}",
            parsed.path,
            parsed.query,
            parsed.fragment,
        )
    )


async def wait_for_native(action: str, awaitable):
    timeout = positive_number("IGGY_TIMEOUT_SECONDS", "10", float)
    try:
        return await asyncio.wait_for(awaitable, timeout=timeout)
    except asyncio.TimeoutError as error:
        raise TestError(f"Native Iggy {action} timed out") from error
    except Exception as error:
        raise TestError(f"Native Iggy {action} failed: {error!r}") from error


async def test_native_connection_async() -> None:
    try:
        from apache_iggy import IggyClient
    except ImportError as error:
        raise TestError(
            "Missing apache-iggy package. Install it with: "
            "python3 -m pip install apache-iggy"
        ) from error

    for name in TOPIC_ENV:
        required_env(name)

    connection_string = native_connection_string()
    try:
        client = IggyClient.from_connection_string(connection_string)
    except Exception as error:
        raise TestError(f"Invalid native Iggy connection string: {error!r}") from error

    await wait_for_native("connect", client.connect())
    stream = required_env("IGGY_STREAM")
    stream_details = await wait_for_native("get_stream", client.get_stream(stream))
    if stream_details is None:
        raise TestError(f"Iggy stream does not exist: {stream}")

    for topic in (required_env("IGGY_INBOX_TOPIC"), required_env("IGGY_ANALYTICS_TOPIC")):
        topic_details = await wait_for_native(
            f"get_topic {stream}/{topic}",
            client.get_topic(stream, topic),
        )
        if topic_details is None:
            raise TestError(f"Iggy topic does not exist: {stream}/{topic}")
        if topic_details.name != topic:
            raise TestError(f"Iggy returned unexpected topic data for {topic}")

    print("PASS: native apache-iggy client can read the configured stream and topics")


def test_native_connection() -> None:
    asyncio.run(test_native_connection_async())


def main() -> int:
    parser = argparse.ArgumentParser(description="Test an Apache Iggy server")
    parser.add_argument(
        "command",
        choices=("check", "test-inbox", "test-analytics", "test-native", "send", "print-new"),
    )
    parser.add_argument("topic", nargs="?")
    args = parser.parse_args()
    topic_commands = {"send", "print-new"}
    if args.command in topic_commands and not args.topic:
        parser.error(f"{args.command} requires a topic name")
    if args.command not in topic_commands and args.topic:
        parser.error(f"{args.command} does not accept a topic name")

    try:
        load_env()
        commands = {
            "check": check,
            "test-inbox": test_inbox,
            "test-analytics": test_analytics,
            "test-native": test_native_connection,
            "send": lambda: send(args.topic),
            "print-new": lambda: print_new(args.topic),
        }
        commands[args.command]()
    except TestError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
