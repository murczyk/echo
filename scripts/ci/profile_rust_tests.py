#!/usr/bin/env python3

import json
import os
from pathlib import Path
import re
import subprocess
import sys


TEST_RESULT = re.compile(
    r"^test (?P<name>.+) \.\.\. (?P<result>ok|FAILED|ignored)"
    r"(?: <(?P<duration>[0-9.]+)s>)?$"
)


def build_test_executable() -> tuple[Path, Path]:
    command = [
        "cargo",
        "test",
        "-p",
        "wdintel-rs",
        "--release",
        "--locked",
        "--no-run",
        "--message-format=json",
    ]
    process = subprocess.run(command, check=True, text=True, capture_output=True)
    executable = None
    test_directory = None
    for line in process.stdout.splitlines():
        message = json.loads(line)
        target = message.get("target", {})
        profile = message.get("profile", {})
        if (
            message.get("reason") == "compiler-artifact"
            and target.get("name") == "wdintel-rs"
            and "bin" in target.get("kind", [])
            and profile.get("test")
            and message.get("executable")
        ):
            executable = Path(message["executable"])
            test_directory = Path(target["src_path"]).parent.parent
    if executable is None or test_directory is None:
        raise RuntimeError("cargo did not report the wdintel-rs test executable")
    return executable, test_directory


def main() -> int:
    executable, test_directory = build_test_executable()
    command = [
        str(executable),
        "-Z",
        "unstable-options",
        "--report-time",
        "--test-threads=1",
    ]
    environment = os.environ.copy()
    environment["RUSTC_BOOTSTRAP"] = "1"
    process = subprocess.Popen(
        command,
        cwd=test_directory,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None

    durations: list[tuple[float, str]] = []
    for line in process.stdout:
        matched = TEST_RESULT.match(line.rstrip())
        if matched is None:
            continue
        print(line, end="", flush=True)
        if matched.group("duration") is None:
            continue
        durations.append(
            (float(matched.group("duration")), matched.group("name"))
        )

    return_code = process.wait()
    if durations:
        print("\nSlowest tests reported by the Rust test harness:")
        for duration, name in sorted(durations, reverse=True)[:20]:
            print(f"{duration:8.3f}s  {name}")
    if return_code != 0:
        print("Test execution failed; rerun cargo test for captured output.")
    return return_code


if __name__ == "__main__":
    sys.exit(main())
