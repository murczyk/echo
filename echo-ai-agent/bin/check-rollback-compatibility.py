#!/usr/bin/env python3

import json
import subprocess
import sys
from pathlib import Path

REQUEST_ID = "rollback-template-compatibility"
MAX_OUTPUT_BYTES = 64 * 1024
TIMEOUT_SECONDS = 30


def dispatcher_accepts_template(dispatcher: Path, namespace: str) -> bool:
    try:
        result = subprocess.run(
            [str(dispatcher), "--namespace", namespace],
            input=(
                json.dumps(
                    {"id": REQUEST_ID, "operation": "preflight"},
                    separators=(",", ":"),
                )
                + "\n"
            ).encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    if result.returncode != 0 or len(result.stdout) > MAX_OUTPUT_BYTES:
        return False
    lines = result.stdout.splitlines()
    if len(lines) != 1:
        return False
    try:
        response = json.loads(lines[0])
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return (
        isinstance(response, dict)
        and response.get("id") == REQUEST_ID
        and response.get("ok") is True
        and response.get("done") is True
        and isinstance(response.get("result"), dict)
        and response["result"].get("template_ready") is True
    )


def main() -> int:
    if len(sys.argv) != 3:
        return 2
    dispatcher = Path(sys.argv[1])
    namespace = sys.argv[2]
    if not dispatcher.is_file() or not dispatcher_accepts_template(
        dispatcher, namespace
    ):
        print(
            "previous dispatcher cannot use the current fixed template",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
