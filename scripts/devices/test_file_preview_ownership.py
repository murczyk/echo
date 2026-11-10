#!/usr/bin/env python3
"""Exercise refusal boundaries with real foreign processes and owned scratch resources."""

import argparse
import hashlib
import os
import signal
import socket
import subprocess
import sys
import tempfile
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


def check_persistent_root():
    parent = harness.REPO / ".dev-runtime/device-files-lab/runtime"
    parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    assert not parent.stat().st_mode & 0o077
    with tempfile.TemporaryDirectory(prefix="echo-device-file-preview-", dir=parent) as directory:
        root = Path(directory)
        run = "0123456789abcdef0123"
        environment = {
            "root": str(root), "repository": str(harness.REPO), "run": run,
            "profile": "device-file-preview", "main_db": f"wd_test_device_file_preview_{run}",
            "files_db": f"wd_files_test_device_file_preview_{run}",
            "bucket": f"device-file-preview-{run}", "config_hashes": {},
            "lab_manager": str(harness.REPO / ".dev-runtime/device-files-lab/manage.py"),
        }
        environment.update({f"{role}_port": port for role, port in zip(
            ("api_a", "api_b", "proxy", "front", "redis", "s3"), range(25001, 25007))})
        for role in ("a", "b"):
            config = {
                "pg_dbname": environment["main_db"], "pg_host": "127.0.0.1",
                "file_registry": {"pg_dbname": environment["files_db"], "pg_host": "127.0.0.1"},
                "s3_config": {"s3_bucket": environment["bucket"], "s3_endpoint": "http://127.0.0.1:25006"},
                "storage_dir": str(root / f"storage-{role}"),
                "redis_host": "127.0.0.1", "redis_port": 25005,
            }
            text = harness.toml_text(config)
            harness.private_write(root / f"config-{role}.toml", text)
            environment["config_hashes"][role] = hashlib.sha256(text.encode()).hexdigest()
        harness.private_write(root / "environment.sh", "# Ownership fixture only\n")
        harness.save(root, environment)
        harness.load(root)
        harness.save(root, {**environment, "lab_manager": "foreign-manager"})
        refused(lambda: harness.load(root))
        harness.save(root, environment)
        os.chmod(root / "config-a.toml", 0o644)
        refused(lambda: harness.load(root))
        os.chmod(root / "config-a.toml", 0o600)
        alias = root.with_name(root.name + "-symlink")
        alias.symlink_to(root, target_is_directory=True)
        try:
            refused(lambda: harness.load(alias))
        finally:
            alias.unlink()
        harness.load(root)
    with tempfile.TemporaryDirectory(prefix="preview-foreign-parent-") as directory:
        foreign = Path(directory) / "echo-device-file-preview-foreign"
        foreign.mkdir(mode=0o700)
        refused(lambda: harness.load(foreign))
    print("PASS: persistent lab root, manager ownership, private config permissions, foreign parent and symlink refusal")


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
    parser.add_argument("--persistent-root-only", action="store_true", help="Test persistent preview ownership without services")
    args = parser.parse_args()
    check_persistent_root()
    if not args.persistent_root_only:
        root, environment = harness.prepare()
        check(root, environment, args.database)
