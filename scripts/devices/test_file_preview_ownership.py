#!/usr/bin/env python3
"""Exercise refusal boundaries with real foreign processes and owned scratch resources."""

import argparse
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from unittest.mock import patch

import file_preview_harness as harness


def refused(action):
    try:
        action()
    except RuntimeError:
        return
    raise AssertionError("Unsafe operation was accepted")


def check(root, environment, database):
    original = (root / "config-a.toml").read_text()
    try:
        harness.private_write(root / "config-a.toml", original.replace(environment["main_db"], "wd"))
        refused(lambda: harness.load(root))
    finally:
        harness.private_write(root / "config-a.toml", original)
    os.chmod(root / "config-a.toml", 0o644)
    try:
        refused(lambda: harness.load(root))
    finally:
        os.chmod(root / "config-a.toml", 0o600)
    foreign = subprocess.Popen(["sleep", "60"], start_new_session=True)
    try:
        record = {"pid": foreign.pid, "started": harness.process_identity(foreign.pid)}
        environment["processes"]["foreign"] = record
        refused(lambda: harness.teardown(root, environment))
        assert foreign.poll() is None, "Foreign process was signaled"
        record["started"] = "different PID lifetime"
        refused(lambda: harness.teardown(root, environment))
        assert foreign.poll() is None, "Reused PID was signaled"
    finally:
        environment["processes"] = {}
        os.killpg(foreign.pid, signal.SIGTERM)
        foreign.wait(timeout=5)
    leader = subprocess.Popen([sys.executable, "-c",
        "import subprocess,sys; child=subprocess.Popen(['sleep','60'],stdout=subprocess.DEVNULL); print(child.pid,flush=True); sys.stdin.read(1)"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, start_new_session=True,
        env=harness.runtime_env(root, environment))
    child = int(leader.stdout.readline().strip())
    record = {"pid": leader.pid, "started": harness.process_identity(leader.pid)}
    environment["processes"]["owned-orphan"] = record
    assert harness.owned_process(record, root, environment), "Owned session could not be observed"
    leader.stdin.write("x")
    leader.stdin.flush()
    leader.wait(timeout=5)
    assert harness.owned_process(record, root, environment), "Owned orphan descendant was lost after leader exit"
    harness.teardown(root, environment)
    assert not harness.process_identity(child), "Owned descendant survived teardown"
    exiting = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"],
        start_new_session=True, env=harness.runtime_env(root, environment))
    record = {"pid": exiting.pid, "started": harness.process_identity(exiting.pid)}
    environment["processes"]["exiting"] = record
    assert harness.owned_process(record, root, environment), "Race fixture process was not observed"
    getsid = os.getsid

    def disappear(pid):
        if pid == exiting.pid:
            exiting.terminate()
            exiting.wait(timeout=5)
            raise ProcessLookupError()
        return getsid(pid)

    with patch.object(harness.os, "getsid", side_effect=disappear):
        assert not harness.owned_process(record, root, environment), "Exited member remained live"
    harness.signal_group(record, signal.SIGTERM)
    environment["processes"] = {}
    redis_env = {key: value for key, value in os.environ.items() if not key.startswith("DEVICE_FILE_PREVIEW_")}
    redis = subprocess.Popen(["redis-server", "--bind", "127.0.0.1", "--port", str(environment["redis_port"]),
        "--save", "", "--appendonly", "no", "--dir", str(root)], env=redis_env,
        start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 5
        while True:
            try:
                with socket.create_connection(("127.0.0.1", environment["redis_port"]), timeout=0.1):
                    break
            except OSError:
                assert time.monotonic() < deadline, "Owned closing-role fixture did not start"
                time.sleep(0.02)
        record = {"pid": redis.pid, "started": harness.process_identity(redis.pid)}
        environment["processes"]["redis"] = record
        observe = harness.observe

        def close_listener(args):
            if args[0] == "lsof" and "-sTCP:LISTEN" in args:
                redis.terminate()
                redis.wait(timeout=5)
            return observe(args)

        with patch.object(harness, "observe", side_effect=close_listener):
            assert not harness.owned_process(record, root, environment), "Closing role remained live"
    finally:
        if redis.poll() is None:
            redis.terminate()
            redis.wait(timeout=5)
        environment["processes"] = {}
    alias = root.with_name(root.name + "-symlink")
    alias.symlink_to(root, target_is_directory=True)
    try:
        refused(lambda: harness.load(alias))
    finally:
        alias.unlink()
    if database:
        name = environment["main_db"]
        assert not harness.sql(root, environment, f"SELECT 1 FROM pg_database WHERE datname='{name}';")
        harness.command(["createdb", name], root, harness.postgres_env(root, environment))
        try:
            environment["database_claimed"] = True
            refused(lambda: harness.teardown(root, environment))
            assert harness.sql(root, environment, f"SELECT 1 FROM pg_database WHERE datname='{name}';") == "1", "Unowned database was dropped"
        finally:
            harness.command(["dropdb", name], root, harness.postgres_env(root, environment))
            environment["database_claimed"] = False
    harness.save(root, environment)
    harness.load(root)
    harness.teardown(root, environment)
    print("PASS: unsafe config/permissions, symlink root, foreign/reused PID, orphan group drain, disappearing member/closing role" + (", unmarked database" if database else ""))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", action="store_true", help="Also test actual owned PostgreSQL scratch DB refusal")
    args = parser.parse_args()
    root, environment = harness.prepare()
    check(root, environment, args.database)
