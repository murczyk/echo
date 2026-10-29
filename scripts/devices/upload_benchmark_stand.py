#!/usr/bin/env python3
"""Private PostgreSQL/Redis/MinIO/Echo stand, supervised by an Orca terminal."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import tomllib

import file_preview_harness as shared

PROFILE = "upload-benchmark"
BINARY = shared.REPO / "target/debug/wdintel-rs"


def prepare(capacity_profile="defaults"):
    shared.docker_host()
    shared.require(BINARY.is_file(), "Build wdintel-rs first")
    root = Path(tempfile.mkdtemp(prefix=f"echo-{PROFILE}-")).resolve()
    run = secrets.token_hex(10)
    ports = shared.fresh_ports()
    state = dict(root=str(root), repository=str(shared.REPO), run=run, profile=PROFILE,
                 main_db=f"wd_test_upload_benchmark_{run}", files_db=f"wd_files_test_upload_benchmark_{run}",
                 bucket=f"upload-benchmark-{run}", container_name=f"upload-benchmark-{run}",
                 container_id=None, database_claimed=False, processes={}, stage="prepared")
    state.update(zip(("pg_port", "redis_port", "api_a_port", "s3_port"), ports))
    state["capacity_profile"] = capacity_profile
    config = tomllib.loads((shared.REPO / "deploy/config-test.toml").read_text())
    config.update(pg_host="127.0.0.1", pg_port=ports[0], pg_user="benchmark", pg_password="",
                  pg_dbname=state["main_db"], redis_host="127.0.0.1", redis_port=ports[1],
                  public_host=f"127.0.0.1:{ports[2]}", storage_dir=str(root / "storage"),
                  static_path=str(shared.REPO / "wdintel-web/public"), executable_path=str(BINARY),
                  cookie_session_secret=secrets.token_hex(32),
                  totp_strongbox_key=base64.b64encode(secrets.token_bytes(32)).decode(),
                  server_id=1, skip_discord_notifications=True,
                  disable_cleanup_networks_worker=True, disable_unit_location_v2_worker=True,
                  disable_suggest_message_tags_worker=True, disable_inactive_users_worker=True)
    config["file_registry"] = {key: config[key] for key in ("pg_host", "pg_port", "pg_user", "pg_password")}
    config["file_registry"]["pg_dbname"] = state["files_db"]
    config["s3_config"] = dict(s3_access_key_id=f"bench{run}", s3_secret_access_key=secrets.token_urlsafe(32),
                               s3_endpoint=f"http://127.0.0.1:{ports[3]}", s3_region="us-east-1",
                               s3_bucket=state["bucket"], strongbox_key=base64.b64encode(secrets.token_bytes(32)).decode())
    config["device_upload_finalization"] = {"enabled": True}
    text = shared.toml_text(config) + """
[file_registry.content_limits]
upload_max_bytes = 268435456
max_reserved_bytes = 1073741824
max_reserved_per_login = 1073741824
spool_min_free_bytes = 536870912
"""
    if capacity_profile == "throughput":
        text += "max_reserved_count = 4096\nmax_count_per_login = 4096\n"
    shared.private_write(root / "config-a.toml", text)
    state["config_sha256"] = hashlib.sha256(text.encode()).hexdigest()
    for directory in ("storage", "cache-a", "cache-bgworker"):
        (root / directory).mkdir(mode=0o700)
    shared.private_write(root / "setup.log", "")
    shared.save(root, state)
    print(root, flush=True)


def load(path):
    root = Path(path).absolute()
    shared.require(root == root.resolve() and root.parent == Path(tempfile.gettempdir()).resolve()
                   and root.name.startswith(f"echo-{PROFILE}-"), "Not an owned stand root")
    shared.private_file(root / shared.STATE_FILE)
    state = json.loads((root / shared.STATE_FILE).read_text())
    shared.require(state["root"] == str(root) and state["repository"] == str(shared.REPO)
                   and state["profile"] == PROFILE, "Stand ownership mismatch")
    shared.require(hashlib.sha256((root / "config-a.toml").read_bytes()).hexdigest()
                   == state["config_sha256"], "Stand config changed")
    return root, state


def runtime_env(root, state, role="a"):
    return {**os.environ, "ECHO_CONFIG_PATH": str(root / "config-a.toml"),
            "TEST_DB_NAME": state["main_db"], "TEST_WDFILE_DB_NAME": state["files_db"],
            "RUST_LOG": "warn", "RUST_BACKTRACE": "0", "ECHO_DEV_BACK_REST_ONLY": "true",
            "TMPDIR": str(root / f"cache-{role}"), "DEVICE_FILE_PREVIEW_CACHE_DIR": str(root / f"cache-{role}")}


def seed(root, state):
    query = lambda statement: shared.sql(root, state, statement, state["main_db"])
    query("UPDATE system_settings SET devices_section_enabled=true,enable_audio_transcription=false,"
          "api_rate_limit_replenish_interval_ms=1,api_rate_limit_burst_size=10000;")
    query("UPDATE datasource SET status='paused' WHERE kind<>'echo_native'; "
          "UPDATE echo_client SET deleted=true; UPDATE gpu_config SET is_active=false;")
    roles = '["Admin","Api","Cyber","CyberViewer"]'
    organism = query(f"INSERT INTO organism(name,roles,enabled) VALUES('bench-{state['run']}','{roles}'::jsonb,true) RETURNING id;")
    zone = query(f"INSERT INTO sigint_zone(name) VALUES('bench-{state['run']}') RETURNING id;")
    login, password = f"bench-{state['run']}", secrets.token_urlsafe(24)
    shared.command([str(BINARY), "--mode=test", "oneoff-register-user", "--login", login,
                    "--password", password, "--role", "Cyber", "--sigint-zone", zone,
                    "--organism-id", organism], root, runtime_env(root, state))
    query(f"UPDATE login SET roles='{roles}'::jsonb WHERE login='{login}';")
    shared.private_write(root / "credentials.json", json.dumps({"user": login, "password": password}))


def serve(root, state):
    shared.require(state["stage"] == "prepared", "Prepare a new stand; refusing to overwrite a run")
    children = []

    def spawn(role, args, env=None):
        with (root / f"{role}.log").open("a") as log:
            process = subprocess.Popen(args, stdout=log, stderr=log, env=env, start_new_session=True)
        children.append(process)
        state["processes"][role] = {"pid": process.pid, "started": shared.process_identity(process.pid)}
        shared.save(root, state)
        return process

    def stop_signal(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_signal)
    state["supervisor"] = {"pid": os.getpid(), "started": shared.process_identity(os.getpid())}
    state["stage"] = "starting"
    shared.save(root, state)
    try:
        shared.command(["initdb", "-D", str(root / "postgres"), "-U", "benchmark",
                        "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=en_US.UTF-8"], root)
        spawn("postgres", ["postgres", "-D", str(root / "postgres"), "-h", "127.0.0.1", "-p", str(state["pg_port"]),
                           "-c", "unix_socket_directories=", "-c", "max_connections=200"])
        for _ in range(100):
            ready = subprocess.run(["pg_isready", "-h", "127.0.0.1", "-p", str(state["pg_port"])], capture_output=True)
            if ready.returncode == 0:
                break
            time.sleep(0.1)
        shared.sql(root, state, "CREATE ROLE wd LOGIN;")
        shared.restore_databases(root, state)
        shared.command([str(BINARY), "--mode=test", "migrate"], root, runtime_env(root, state))
        seed(root, state)
        shared.start_storage(root, state)
        spawn("redis", ["redis-server", "--bind", "127.0.0.1", "--port", str(state["redis_port"]),
                        "--save", "", "--appendonly", "no", "--dir", str(root)])
        spawn("api", [sys.executable, str(Path(__file__).resolve()), "api", "--root", str(root)])
        shared.wait_url(f"http://127.0.0.1:{state['api_a_port']}/api/ping", 120)
        spawn("bgworker", [str(BINARY), "--mode=debug", "bgworker"], runtime_env(root, state, "bgworker"))
        state["stage"] = "ready"
        state["git_head"] = shared.command(["git", "rev-parse", "HEAD"])
        state["binary_sha256"] = hashlib.file_digest(BINARY.open("rb"), "sha256").hexdigest()
        shared.save(root, state)
        print(json.dumps({"root": str(root), "api": f"http://127.0.0.1:{state['api_a_port']}", "stage": "ready"}), flush=True)
        while True:
            shared.require(all(child.poll() is None for child in children), "A stand service exited; inspect logs")
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        for process in reversed(children):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM if process != children[0] else signal.SIGINT)
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
        if state["container_id"]:
            details = json.loads(shared.command(["docker", "inspect", state["container_id"]]))[0]
            shared.require(details["Config"]["Labels"].get(f"echo.{PROFILE}.run") == state["run"], "Foreign container")
            shared.command(["docker", "rm", "--force", "--volumes", state["container_id"]], root)
            state["container_id"] = None
        state["stage"] = "stopped"
        shared.save(root, state)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "serve", "status", "stop", "api"))
    parser.add_argument("--root")
    parser.add_argument("--capacity-profile", choices=("defaults", "throughput"), default="defaults")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.capacity_profile)
        return
    parser.error("--root is required") if not args.root else None
    root, state = load(args.root)
    if args.command == "serve":
        serve(root, state)
    elif args.command == "status":
        print(json.dumps({key: state.get(key) for key in ("stage", "root", "api_a_port", "pg_port", "redis_port", "s3_port", "processes")}, indent=2))
    elif args.command == "stop":
        owner = state["supervisor"]
        shared.require(shared.process_identity(owner["pid"]) == owner["started"], "Supervisor is absent or PID was reused")
        os.kill(owner["pid"], signal.SIGTERM)
    else:
        listener = socket.socket()
        listener.bind(("127.0.0.1", state["api_a_port"]))
        listener.listen(128)
        os.dup2(listener.fileno(), 3)
        os.set_inheritable(3, True)
        env = runtime_env(root, state)
        env.update(LISTEN_PID=str(os.getpid()), LISTEN_FDS="1")
        os.execve(str(BINARY), [str(BINARY), "--mode=debug", "server", "--no-bgworker"], env)


if __name__ == "__main__":
    main()
