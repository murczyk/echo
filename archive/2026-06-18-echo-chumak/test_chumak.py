#!/usr/bin/env python3

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http.cookiejar import CookieJar
from pathlib import Path


ENV_PATH = Path(__file__).with_name(".env")
REQUIRED_ENV = ("ECHO_BASE_URL", "ECHO_LOGIN", "ECHO_PASSWORD")


class TestError(Exception):
    pass


def load_env() -> None:
    if not ENV_PATH.exists():
        raise TestError(f"Missing {ENV_PATH}. Copy .env.example to .env and fill it in.")

    for line_number, raw_line in enumerate(ENV_PATH.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            raise TestError(f"Invalid .env line {line_number}: expected KEY=VALUE")
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise TestError(f"Missing required environment variable: {name}")
    return value


def optional_env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def optional_int(name: str):
    value = optional_env(name)
    if not value:
        return None
    try:
        return int(value)
    except ValueError as error:
        raise TestError(f"{name} must be an integer, got: {value}") from error


class EchoClient:
    def __init__(self) -> None:
        for name in REQUIRED_ENV:
            required_env(name)
        self.base_url = required_env("ECHO_BASE_URL").rstrip("/")
        self.login_name = required_env("ECHO_LOGIN")
        self.password = required_env("ECHO_PASSWORD")
        self.timeout = float(optional_env("ECHO_TIMEOUT_SECONDS", "10"))
        self.cookies = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies)
        )

    def login(self) -> None:
        self.request(
            "POST",
            "/api/user/login",
            {"user": self.login_name, "password": self.password},
            authenticated=False,
        )
        if not list(self.cookies):
            raise TestError("Echo login did not set a session cookie")

    def request(self, method: str, path: str, body=None, authenticated: bool = True):
        if authenticated and not list(self.cookies):
            raise TestError("Echo client is not authenticated")
        url = f"{self.base_url}{path}"
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                payload = response.read()
        except urllib.error.HTTPError as error:
            details = error.read().decode("utf-8", errors="replace")
            raise TestError(f"{method} {url} failed with HTTP {error.code}: {details}") from error
        except urllib.error.URLError as error:
            raise TestError(f"{method} {url} failed: {error.reason}") from error

        if not payload:
            return {}
        try:
            return json.loads(payload)
        except json.JSONDecodeError:
            return payload.decode("utf-8", errors="replace")

    def cookie_header(self) -> str:
        return "; ".join(f"{cookie.name}={cookie.value}" for cookie in self.cookies)


def connected_client() -> EchoClient:
    client = EchoClient()
    client.login()
    return client


def network_payload() -> dict:
    return {
        "freq": required_env("ECHO_CHUMAK_FREQ"),
        "aor_id": optional_int("ECHO_CHUMAK_AOR_ID"),
        "color_code": optional_env("ECHO_CHUMAK_COLOR_CODE") or None,
    }


def submit_payload() -> dict:
    timestamp = datetime.now().replace(microsecond=0).isoformat()
    freq = required_env("ECHO_CHUMAK_FREQ")
    color_code = int(optional_env("ECHO_CHUMAK_COLOR_CODE", "1"))
    sender_id = 110
    abonent_id = 50
    location = optional_env("ECHO_CHUMAK_LOCATION", "ЛИМАН ПЕРШИЙ")
    message = (
        f"{timestamp} F={freq} (МГц)\n"
        f"УКХ р/м СС:{color_code} CG:{abonent_id}\n"
        f"ID➡️:{sender_id}(ЯРУС)\n"
        "Тестове повідомлення Chumak"
    )
    return {
        "message": message,
        "timestamp": timestamp,
        "freq": freq,
        "locations": [location] if location else [],
        "tags": ["chumak-test"],
        "no_headers_body": "Тестове повідомлення Chumak",
        "media": [],
        "coordinates": optional_env("ECHO_CHUMAK_COORDINATES") or None,
        "signals": "dmr",
        "callsign_from": str(sender_id),
        "callsign_to": str(abonent_id),
        "callsigns_other": [],
        "network_name": "Chumak test network",
        "unit": None,
        "group_names": [required_env("ECHO_CHUMAK_GROUP")],
        "sender": optional_env("ECHO_CHUMAK_SENDER", "chumak"),
        "post": optional_env("ECHO_CHUMAK_POST") or None,
        "network": {"signal_name": "dmr", "cc": color_code, "name": "Chumak test network"},
        "dmr": [
            {
                "timestamp": timestamp,
                "cc": color_code,
                "freq": freq,
                "signal_name": "Dmr",
                "sender_id": sender_id,
                "abonent_id": abonent_id,
            }
        ],
    }


def login() -> None:
    client = connected_client()
    print(f"PASS: logged in as {client.login_name}")
    print(f"Cookie: {client.cookie_header()}")


def find_networks() -> None:
    client = connected_client()
    payload = network_payload()
    print(f"Request payload: {json.dumps(payload, ensure_ascii=False)}")
    response = client.request("POST", "/api/sigint/network/find-live", payload)
    print(json.dumps(response, ensure_ascii=False, indent=2))


def submit_message() -> None:
    client = connected_client()
    payload = submit_payload()
    print(f"Request payload: {json.dumps(payload, ensure_ascii=False, indent=2)}")
    response = client.request("POST", "/api/rer-importer/inbox/chumak-submit", payload)
    print(json.dumps(response, ensure_ascii=False, indent=2))
    print("PASS: submitted Chumak inbox message")


def main() -> int:
    parser = argparse.ArgumentParser(description="Test Echo Chumak integration endpoints")
    parser.add_argument("command", choices=("login", "find-networks", "submit-message"))
    args = parser.parse_args()

    try:
        load_env()
        commands = {
            "login": login,
            "find-networks": find_networks,
            "submit-message": submit_message,
        }
        commands[args.command]()
    except TestError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
