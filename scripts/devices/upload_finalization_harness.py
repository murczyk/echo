#!/usr/bin/env python3
"""Owned shared-root, real-process async upload recovery fixture (Python 3.11+)."""

import argparse
import base64
import concurrent.futures
import fcntl
import hashlib
import http.cookiejar
import http.server
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import shlex
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
import uuid
import wave

import file_preview_harness as shared

PROFILE = "upload-finalization"
PHASE7 = ("source-pin", "storage-recovery", "publication", "fencing", "post-publication")
PHASE8 = ("performance", "resource-bounds")
PHASE9 = ("rollout",)
LATER = ("compatibility", "admission")
CONCURRENCY = 32
ADMISSIONS_PER_KIND = 100
HEAVY_DELAY_SECONDS = 30
SCHEDULER_SECONDS = 60
RECEIPT_LOCK = threading.Lock()
ROLES = ("api-a", "api-b", "bgworker")
BINARY = shared.REPO / "target/debug/wdintel-rs"


def require(condition, message):
    shared.require(condition, message)


def load(root):
    root = Path(root).absolute()
    info = root.lstat()
    require(root == root.resolve() and root.parent == Path(tempfile.gettempdir()).resolve()
            and root.name.startswith("echo-upload-finalization-") and stat.S_ISDIR(info.st_mode)
            and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            "Refusing a foreign, symlinked, or non-private fixture root")
    shared.private_file(root / shared.STATE_FILE)
    environment = json.loads((root / shared.STATE_FILE).read_text())
    run = environment["run"]
    require(re.fullmatch(r"[a-f0-9]{20}", run) and environment["root"] == str(root)
            and environment["repository"] == str(shared.REPO) and environment["profile"] == PROFILE,
            "Fixture ownership mismatch")
    require(environment["main_db"] == f"wd_test_upload_finalization_{run}"
            and environment["files_db"] == f"wd_files_test_upload_finalization_{run}"
            and environment["bucket"] == f"upload-finalization-{run}", "Unsafe fixture resource names")
    ports = [environment[key] for key in ("api_a_port", "api_b_port", "s3_port", "pg_proxy_port")]
    require(len(set(ports)) == len(ports) and all(isinstance(port, int) and 1024 < port < 65536 for port in ports),
            "Invalid dedicated loopback ports")
    for role in ("a", "b"):
        path = root / f"config-{role}.toml"
        shared.private_file(path)
        require(hashlib.sha256(path.read_bytes()).hexdigest() == environment["config_hashes"][role],
                "Fixture configuration changed after ownership was established")
        config = tomllib.loads(path.read_text())
        require(config["pg_host"] == config["file_registry"]["pg_host"] == "127.0.0.1"
                and config["pg_port"] == environment["pg_port"]
                and config["file_registry"]["pg_port"] == environment["pg_proxy_port"]
                and config["pg_port"] != 5432 and config["pg_dbname"] == environment["main_db"]
                and config["file_registry"]["pg_dbname"] == environment["files_db"]
                and config["storage_dir"] == str(root / "storage")
                and config["redis_host"] == "127.0.0.1"
                and config["redis_port"] == environment["redis_port"] != 6379
                and config["s3_config"]["s3_bucket"] == environment["bucket"]
                and config["s3_config"]["s3_endpoint"] == f"http://127.0.0.1:{environment['s3_port']}",
                "Unsafe fixture database/storage/Redis configuration")
    shared.private_file(root / "environment.sh")
    return root, environment


def prepare():
    for dependency in ("psql", "pg_restore", "createdb", "dropdb", "ffmpeg", "ffprobe", "lsof"):
        require(shared.shutil.which(dependency), f"Missing fixture prerequisite: {dependency}")
    source = os.environ.get("ECHO_CONFIG_PATH")
    require(source, "Set ECHO_CONFIG_PATH to the approved isolated config before prepare")
    config = tomllib.loads(Path(source).read_text())
    require(config["pg_host"] == "127.0.0.1" and config["pg_port"] != 5432
            and config["redis_host"] == "127.0.0.1" and config["redis_port"] != 6379,
            "Only explicit non-default isolated loopback PostgreSQL/Redis are allowed")
    storage_python = Path(os.environ.get("UPLOAD_FINALIZATION_STORAGE_PYTHON",
                                         shared.REPO / "target/phase7-harness-storage-venv/bin/python")).absolute()
    require(storage_python.is_file(), "Provision a Python 3.11+ venv with deploy/ci/test-storage-requirements.txt first")
    result = subprocess.run([str(storage_python), "-c",
        "import sys; assert sys.version_info >= (3, 11); import tomllib; import moto.server"], capture_output=True)
    require(result.returncode == 0, "The selected storage Python must be Python 3.11+ with tomllib and Moto")
    root = Path(tempfile.mkdtemp(prefix="echo-upload-finalization-")).resolve()
    os.chmod(root, 0o700)
    run = secrets.token_hex(10)
    ports = shared.fresh_ports()
    environment = {"profile": PROFILE, "root": str(root), "repository": str(shared.REPO), "run": run,
                   "stage": "prepared", "main_db": f"wd_test_upload_finalization_{run}",
                   "files_db": f"wd_files_test_upload_finalization_{run}", "bucket": f"upload-finalization-{run}",
                   "pg_port": config["pg_port"], "redis_port": config["redis_port"],
                   "api_a_port": ports[0], "api_b_port": ports[1], "s3_port": ports[2], "pg_proxy_port": ports[3],
                   "storage_python": str(storage_python), "processes": {}, "database_claimed": False,
                   "container_id": None, "config_hashes": {}}
    config.update(pg_dbname=environment["main_db"], public_host=f"127.0.0.1:{ports[0]}",
                  cookie_session_secret=secrets.token_hex(32),
                  totp_strongbox_key=base64.b64encode(secrets.token_bytes(32)).decode(),
                  storage_dir=str(root / "storage"), static_path=str(shared.REPO / "wdintel-web/public"),
                  executable_path=str(BINARY), server_id=1, skip_discord_notifications=True,
                  disable_cleanup_networks_worker=True, disable_unit_location_v2_worker=True,
                  disable_suggest_message_tags_worker=True, disable_inactive_users_worker=True)
    config["file_registry"] = {key: config[key] for key in ("pg_host", "pg_port", "pg_user", "pg_password")}
    config["file_registry"]["pg_dbname"] = environment["files_db"]
    config["file_registry"]["pg_port"] = environment["pg_proxy_port"]
    config["s3_config"] = {"s3_access_key_id": f"upload{run}", "s3_secret_access_key": secrets.token_urlsafe(32),
                           "s3_endpoint": f"http://127.0.0.1:{ports[2]}", "s3_region": "us-east-1",
                           "s3_bucket": environment["bucket"],
                           "strongbox_key": base64.b64encode(secrets.token_bytes(32)).decode()}
    config["device_upload_finalization"] = {"enabled": True, "file_slots": 1, "audio_slots": 1,
        "poll_seconds": 1, "lease_seconds": 12, "heartbeat_seconds": 2,
        "retry_min_seconds": 1, "retry_max_seconds": 2, "shutdown_grace_seconds": 5}
    for directory in ("storage", "cache-a", "cache-b", "cache-bgworker", "cache-replacement", "cache-storage", "cache-pg-proxy"):
        (root / directory).mkdir(mode=0o700)
    for role in (*ROLES, "replacement"):
        (root / f"faults-{role}").mkdir(mode=0o700)
    for role in ("a", "b"):
        text = shared.toml_text(config)
        shared.private_write(root / f"config-{role}.toml", text)
        environment["config_hashes"][role] = hashlib.sha256(text.encode()).hexdigest()
    values = {"UPLOAD_FINALIZATION_ROOT": str(root), "ECHO_CONFIG_PATH": str(root / "config-a.toml"),
              "TEST_DB_NAME": environment["main_db"], "TEST_WDFILE_DB_NAME": environment["files_db"],
              "PG_HOST": "127.0.0.1", "PG_PORT": str(environment["pg_port"]),
              "PG_USER": config["pg_user"], "PG_PASSWORD": config["pg_password"],
              "UPLOAD_FINALIZATION_API_A": f"http://127.0.0.1:{ports[0]}",
              "UPLOAD_FINALIZATION_API_B": f"http://127.0.0.1:{ports[1]}"}
    shared.private_write(root / "environment.sh", "".join(f"export {key}={shlex.quote(value)}\n" for key, value in values.items()))
    for name, value in (("fixtures-private.json", {"run": run, "actors": {}, "seeded": []}),
                        ("storage-control.json", {"mode": "normal"}), ("pg-control.json", {"mode": "normal"})):
        shared.private_write(root / name, json.dumps(value))
    shared.private_write(root / "setup.log", "")
    shared.save(root, environment)
    load(root)
    print(root)


def runtime_env(root, environment, role="api-a"):
    config_role = "b" if role == "api-b" else "a"
    cache_role = role[4:] if role.startswith("api-") else role
    config = tomllib.loads((root / f"config-{config_role}.toml").read_text())
    return {**os.environ, "ECHO_CONFIG_PATH": str(root / f"config-{config_role}.toml"),
            "TEST_DB_NAME": environment["main_db"], "TEST_WDFILE_DB_NAME": environment["files_db"],
            "PG_HOST": "127.0.0.1", "PG_PORT": str(environment["pg_port"]),
            "PG_USER": config["pg_user"], "PG_PASSWORD": config["pg_password"],
            "DEVICE_FILE_PREVIEW_ROOT": str(root), "DEVICE_FILE_PREVIEW_RUN": environment["run"],
            "AUDIO_TEST_ROOT": str(root), "RUST_BACKTRACE": "0", "RUST_LOG": "warn",
            "ECHO_UPLOAD_FINALIZATION_FAULT_ROOT": str(root / f"faults-{role}"),
            "DEVICE_FILE_PREVIEW_CACHE_DIR": str(root / f"cache-{cache_role}"),
            "TMPDIR": str(root / f"cache-{cache_role}"), "TMP": str(root / f"cache-{cache_role}"),
            "TEMP": str(root / f"cache-{cache_role}")}


def receipt(root, value):
    with RECEIPT_LOCK:
        with (root / "receipts.jsonl").open("a") as output:
            output.write(json.dumps({"at": shared.datetime.now(shared.timezone.utc).isoformat(), **value}) + "\n")


def launcher_env(root, environment, role="api-a"):
    launch = runtime_env(root, environment, role)
    for key in ("TMPDIR", "TMP", "TEMP"):
        if key in os.environ:
            launch[key] = os.environ[key]
        else:
            launch.pop(key, None)
    return launch


def spawn(root, environment, role):
    previous = environment["processes"].get(role)
    require(not previous or not shared.owned_process(previous, root, environment), f"Owned {role} is already running")
    python = environment["storage_python"] if role == "storage" else sys.executable
    with (root / f"{role}.log").open("a") as log:
        process = subprocess.Popen([python, str(Path(__file__).resolve()), "run-role", "--root", str(root), "--role", role],
                                   cwd=shared.REPO, stdout=log, stderr=log, start_new_session=True,
                                   env=launcher_env(root, environment, role))
    started = shared.process_identity(process.pid)
    require(started, f"Owned {role} launcher exited")
    environment["processes"][role] = {"pid": process.pid, "started": started}
    shared.save(root, environment)
    receipt(root, {"event": "spawn", "role": role, "pid": process.pid, "started": started})
    if role.startswith("api-"):
        shared.wait_url(f"http://127.0.0.1:{environment[f'api_{role[-1]}_port']}/api/ping", 120)
    return process.pid


def stop_role(root, environment, role, crash=False):
    record = environment["processes"].get(role)
    if not record or not shared.owned_process(record, root, environment):
        return
    shared.signal_group(record, signal.SIGCONT)
    shared.signal_group(record, signal.SIGKILL if crash else signal.SIGTERM)
    until(lambda: not shared.owned_process(record, root, environment), 15, f"{role} process group exit")
    receipt(root, {"event": "exit", "role": role, "pid": record["pid"], "signal": "SIGKILL" if crash else "SIGTERM"})


def seed_actor(root, environment):
    isolate_restored_messengers(root, environment)
    query = lambda statement: shared.sql(root, environment, statement, environment["main_db"])
    query("UPDATE system_settings SET devices_section_enabled=true,enable_audio_transcription=false;")
    roles = '["Admin","Api","Cyber","CyberViewer"]'
    organism = query(f"INSERT INTO organism(name,roles,enabled) VALUES('finalization-{environment['run']}','{roles}'::jsonb,true) RETURNING id;")
    zone = query(f"INSERT INTO sigint_zone(name) VALUES('finalization-{environment['run']}') RETURNING id;")
    require(organism.isdigit() and zone.isdigit(), "Invalid fixture actor parents")
    login, password = f"finalization-{environment['run']}", secrets.token_urlsafe(24)
    shared.command([str(BINARY), "--mode=test", "oneoff-register-user", "--login", login, "--password", password,
                    "--role", "Cyber", "--sigint-zone", zone, "--organism-id", organism], root, runtime_env(root, environment))
    query(f"UPDATE login SET roles='{roles}'::jsonb WHERE login='{login}';")
    shared.private_write(root / "fixtures-private.json", json.dumps({"run": environment["run"],
        "actors": {"source": {"login": login, "password": password}}, "seeded": []}, indent=2))


def isolate_restored_messengers(root, environment):
    name = environment["main_db"]
    marker = shared.sql(root, environment,
        f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{name}';")
    require(marker == f"echo-{PROFILE}:{environment['run']}", "Refusing messenger isolation in a foreign database")
    query = lambda statement: shared.sql(root, environment, statement, name)
    status = query("SELECT data_type||':'||udt_name FROM information_schema.columns "
                   "WHERE table_schema='public' AND table_name='datasource' AND column_name='status';")
    deleted = query("SELECT data_type||':'||udt_name FROM information_schema.columns "
                    "WHERE table_schema='public' AND table_name='echo_client' AND column_name='deleted';")
    require(status == "USER-DEFINED:account_status" and deleted == "boolean:bool",
            "Restored messenger fixture column types differ from the supported schema")
    active = int(query("SELECT count(*) FROM datasource WHERE status='active';"))
    clients = int(query("SELECT count(*) FROM echo_client WHERE NOT deleted;"))
    query("BEGIN; UPDATE datasource SET status='paused' WHERE status<>'paused'; "
          "UPDATE echo_client SET deleted=true WHERE NOT deleted; COMMIT;")
    require(query("SELECT count(*) FROM datasource WHERE status='active';") == "0"
            and query("SELECT count(*) FROM echo_client WHERE NOT deleted;") == "0",
            "Restored messenger fixture was not isolated before Echo startup")
    receipt(root, {"event": "restored-messenger-fixture-isolated", "active_datasources_before": active,
                   "undeleted_clients_before": clients, "database": name})


def start(root, environment):
    require(environment["stage"] == "prepared", "Start requires a fresh prepared fixture; stop incomplete runs before retiring it")
    require(BINARY.is_file(), "Build target/debug/wdintel-rs before start; this harness never builds")
    require((shared.REPO / "deploy/wd_test-2025-08-17-07-43.pgrestore").is_file(), "Standard test dump is missing")
    environment["stage"] = "starting"
    shared.save(root, environment)
    shared.restore_databases(root, environment)
    spawn(root, environment, "pg-proxy")
    def proxy_ready():
        try:
            with socket.create_connection(("127.0.0.1", environment["pg_proxy_port"]), timeout=1):
                return True
        except OSError:
            return False
    until(proxy_ready, 15, "owned PostgreSQL proxy listener")
    shared.command([str(BINARY), "--mode=test", "migrate"], root, runtime_env(root, environment))
    seed_actor(root, environment)
    spawn(root, environment, "storage")
    shared.wait_url(f"http://127.0.0.1:{environment['s3_port']}/", 30)
    shared.command([environment["storage_python"], str(Path(__file__).resolve()), "storage-probe", "--root", str(root)],
                   root, launcher_env(root, environment))
    for role in ROLES:
        spawn(root, environment, role)
    environment["stage"] = "ready"
    shared.save(root, environment)
    Scenario(root, environment).login()
    print("Ready; private process/request receipts:", root / "receipts.jsonl")


def until(check, seconds=60, description="fixture transition"):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for {description}")


class Scenario:
    def __init__(self, root, environment):
        self.root, self.environment = root, environment
        require(environment["stage"] == "ready", "Scenario requires a ready owned fixture")
        self.check_databases()
        self.cookies = http.cookiejar.MozillaCookieJar(str(root / "cookies-private.txt"))
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.cookies))
        self.name = "setup"
        self.cookie_lock = threading.Lock()

    def check_databases(self):
        for key in ("main_db", "files_db"):
            name = self.environment[key]
            marker = shared.sql(self.root, self.environment,
                f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{name}';")
            require(marker == f"echo-{PROFILE}:{self.environment['run']}", "Refusing unowned fixture database")

    def sql(self, statement, files=True):
        return shared.sql(self.root, self.environment, statement,
                          self.environment["files_db" if files else "main_db"])

    def request(self, path, value=None, method="POST", headers=None, role="a", expected=None, rate_retries=3):
        require(path.startswith("/") and not path.startswith("//"), "Only relative owned API paths are allowed")
        url = f"http://127.0.0.1:{self.environment[f'api_{role}_port']}{path}"
        body = json.dumps(value).encode() if isinstance(value, dict) else value
        request = urllib.request.Request(url, data=body, method=method,
                                         headers=headers or {"Content-Type": "application/json"})
        begin = time.monotonic()
        try:
            response = self.opener.open(request, timeout=90)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            status = response.status
            response_headers = {key.lower(): value for key, value in response.headers.items()}
        with self.cookie_lock:
            for cookie in self.cookies:
                cookie.secure = False
            self.cookies.save(ignore_discard=True, ignore_expires=True)
            os.chmod(self.root / "cookies-private.txt", 0o600)
        result = json.loads(body) if body and "json" in response_headers.get("content-type", "") else body
        receipt(self.root, {"event": "http", "scenario": self.name, "method": method, "path": path,
                            "api": role, "status": status, "seconds": time.monotonic() - begin})
        statuses = (expected,) if isinstance(expected, int) else expected or ()
        if status == 429 and 429 not in statuses and rate_retries:
            delay = max(1, int(response_headers.get("retry-after", "1")))
            require(delay <= 30, "Owned API rate-limit retry exceeds the fixture wait budget")
            receipt(self.root, {"event": "api-rate-limit-retry", "scenario": self.name, "seconds": delay})
            time.sleep(delay)
            return self.request(path, value, method, headers, role, expected, rate_retries - 1)
        if expected is not None:
            require(status in statuses,
                    f"{method} {path}: HTTP {status}; expected {expected}")
        return status, result, response_headers

    def login(self):
        actor = json.loads((self.root / "fixtures-private.json").read_text())["actors"]["source"]
        self.request("/api/user/test-api-login", {"user": actor["login"], "password": actor["password"]}, expected=200)
        require(bool(list(self.cookies)), "Real login returned no Redis-backed session cookie")

    def upload(self, kind, maximum=False):
        _, device, _ = self.request("/api/device/create", {"name": f"finalization-{uuid.uuid4()}"}, expected=200)
        device = device["id"]
        if kind == "file":
            size = self.upload_limit(kind) if maximum else 32768
            chunk = secrets.token_bytes(min(size, 64 * 1024 * 1024))
            digest = hashlib.sha256()
            for offset in range(0, size, len(chunk)):
                digest.update(chunk[:min(len(chunk), size - offset)])
            payload_hash = digest.hexdigest()
            _, sync, _ = self.request("/api/device/files/sync", {"device_id": device, "files": [{
                "absolute_path": f"C:\\finalization\\{uuid.uuid4()}.bin", "mime_type": "application/octet-stream",
                "extension": "bin", "file_metadata_created_at": None,
                "file_metadata_modified_at": shared.datetime.now(shared.timezone.utc).isoformat(), "source_file_state": None}]}, expected=200)
            file = sync["results"][0]["file"]
            path = f"/api/device/files/{device}/{file['file_id']}/revisions/{file['revision']}/content-uploads"
            metadata = {"Upload-Metadata": "sha256 " + base64.b64encode(bytes.fromhex(payload_hash)).decode()}
        else:
            output = io.BytesIO()
            with wave.open(output, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(8000)
                frames = self.upload_limit(kind) - 44 if maximum else 16000
                wav.writeframes(secrets.token_bytes(frames))
            payload = output.getvalue()
            size, payload_hash = len(payload), hashlib.sha256(payload).hexdigest()
            path, metadata = f"/api/device/audio/{device}/uploads", {}
        _, _, headers = self.request(path, method="POST", headers={"Tus-Resumable": "1.0.0", "Upload-Length": str(size), **metadata}, expected=201)
        location = headers["location"]
        if location.startswith("http://"):
            parsed = urllib.parse.urlsplit(location)
            require(parsed.hostname == "127.0.0.1" and parsed.port == self.environment["api_a_port"], "Foreign upload URL")
            location = parsed.path
        if maximum:
            free = shared.shutil.disk_usage(self.root).free
            require(free >= size + 4 * 1024 ** 3, "Maximum upload requires its real bytes plus 4 GiB free headroom")
        for offset in range(0, size, len(chunk) if kind == "file" else 8 * 1024 * 1024):
            body = chunk[:min(len(chunk), size - offset)] if kind == "file" else payload[offset:offset + 8 * 1024 * 1024]
            self.patch_upload(location, body, offset, maximum)
        upload_id = location.rsplit("/", 1)[1].split(".", 1)[0]
        uuid.UUID(upload_id)
        command = {"kind": kind, "device": device, "location": location, "upload_id": upload_id,
                   "payload_sha256": payload_hash, "payload_size": size, "maximum": maximum}
        if kind == "file":
            command.update(path=location + "/complete", body={"async_finalization": True}, file=file)
        else:
            command.update(path="/api/device/audio/receive", body={"device_id": device,
                "upload_url": location, "name": f"{uuid.uuid4()}.wav", "recording_started_at": "2026-10-01T10:00:00Z",
                "async_finalization": True})
            completed = self.root / "storage/device-audio-tus" / device / "file_upload_tus/completed"
            sources = list(completed.rglob(f"{upload_id}.{size}"))
            require(len(sources) == 1, "Completed audio TUS source has no unique owned directory")
            info = sources[0].parent.stat()
            command["source_directory_identity"] = (info.st_dev, info.st_ino)
        receipt(self.root, {"event": "prepared-command", "scenario": self.name, "command": command})
        return command

    def patch_upload(self, location, body, offset, maximum):
        for attempt in range(4):
            if maximum:
                time.sleep(0.5)
            try:
                self.request(location, body, "PATCH", {"Tus-Resumable": "1.0.0", "Upload-Offset": str(offset),
                             "Content-Type": "application/offset+octet-stream"}, expected=204)
                return
            except (urllib.error.URLError, ConnectionError, TimeoutError) as error:
                if not maximum or attempt == 3:
                    raise
                time.sleep(1)
                _, _, headers = self.request(location, method="HEAD", headers={"Tus-Resumable": "1.0.0"}, expected=204)
                actual = int(headers["upload-offset"])
                require(offset <= actual <= offset + len(body), "TUS transport recovery reported an impossible offset")
                receipt(self.root, {"event": "upload-transport-resume", "scenario": self.name,
                    "path": location, "previous_offset": offset, "confirmed_offset": actual,
                    "attempt": attempt + 1, "error": str(error), "scope": "pre-admission byte transfer only"})
                body = body[actual - offset:]
                offset = actual
                if not body:
                    return

    def accept(self, command, role="a", expected=(200, 202), measured=False):
        status, value, headers = self.request(command["path"], command["body"], role=role,
            headers={"Content-Type": "application/json", "Tus-Resumable": "1.0.0"}, expected=expected,
            rate_retries=0 if measured else 3)
        require("no-store" in headers.get("cache-control", ""), "Async response is cacheable")
        require("job_id" in value, "Async response has no durable job identity")
        command["job_id"] = value["job_id"]
        receipt(self.root, {"event": "accepted" if status == 202 else "replay", "scenario": self.name,
                            "kind": command["kind"], "upload_id": command["upload_id"],
                            "job_id": command["job_id"], "status": value["status"]})
        return value

    def row(self, command):
        value = self.sql(f"SELECT row_to_json(j) FROM device_upload_finalization_job j WHERE id='{command['job_id']}';")
        return json.loads(value) if value else None

    def source(self, command):
        row = self.row(command)
        require(row and row["source_locator"], "Nonempty accepted upload has no durable locator")
        directory = self.root / "storage"
        if command["kind"] == "file":
            directory /= "device-file-content-spool"
        source = directory / row["source_locator"]
        require(source.is_relative_to(self.root / "storage") and source.resolve().is_relative_to(self.root / "storage"),
                "Foreign source locator")
        return source

    def source_intact(self, command):
        source = self.source(command)
        require(source.is_file() and source.stat().st_size == command["payload_size"]
                and self.source_digest(source) == command["payload_sha256"],
                "Accepted source bytes were lost or changed")

    def completed(self, command, status="completed", seconds=90):
        def check():
            row = self.row(command)
            if row and row["status"] in ("completed", "failed"):
                require(row["status"] == status, f"Job terminalized as {row['status']}: {row['error_code']}")
                return row
        row = until(check, seconds, f"automatic {status} without status GET")
        attempts = json.loads(self.sql(f"SELECT coalesce(json_agg(a),'[]') FROM device_upload_finalization_attempt a WHERE job_id='{command['job_id']}';"))
        receipt(self.root, {"event": "terminal", "scenario": self.name, "job_id": command["job_id"],
                            "kind": command["kind"], "status": row["status"], "result": row["result"],
                            "lease_epoch": row["lease_epoch"], "attempt_count": row["attempt_count"],
                            "source_release_state": row["source_release_state"],
                            "attempts": [{key: a[key] for key in ("id", "phase", "object_key", "write_credit_held")} for a in attempts]})
        if status == "completed":
            count = self.sql(f"SELECT count(*) FROM {'file_content' if command['kind'] == 'file' else 'device_audio'} WHERE " +
                (f"upload_id='{command['upload_id']}';" if command["kind"] == "file" else f"id='{row['audio_id']}';"))
            require(count == "1", "Expected exactly one publication receipt")
            require(sum(a["phase"] == "selected" for a in attempts) == 1, "Publication did not select exactly one attempt")
        return row

    def arm(self, role, stage, identity="*"):
        directory = self.root / f"faults-{role}"
        for suffix in ("arm", "active", "reached", "release"):
            (directory / f"{stage}.{suffix}").unlink(missing_ok=True)
        shared.private_write(directory / f"{stage}.arm", identity)

    def reached(self, role, stage):
        path = self.root / f"faults-{role}" / f"{stage}.reached"
        def read():
            try:
                return json.loads(path.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                return None
        value = until(read, 90 if stage.endswith("source_removed") else 60, f"real process hook {stage}")
        require(value["pid"] == self.environment["processes"][role]["pid"], "Hook came from a foreign process")
        receipt(self.root, {"event": "boundary", "scenario": self.name, "role": role, "stage": stage, **value})
        return value

    def clear(self, role, stage):
        directory = self.root / f"faults-{role}"
        for suffix in ("arm", "active"):
            (directory / f"{stage}.{suffix}").unlink(missing_ok=True)
        shared.private_write(directory / f"{stage}.release", "release")

    def restart(self, role, crash=True):
        stop_role(self.root, self.environment, role, crash)
        spawn(self.root, self.environment, role)

    def control(self, mode):
        shared.private_write(self.root / "storage-control.json", json.dumps({"mode": mode}))
        receipt(self.root, {"event": "storage-control", "scenario": self.name, "mode": mode})

    def pg_control(self, mode, job_id=None):
        shared.private_write(self.root / "pg-control.json", json.dumps({"mode": mode, "job_id": job_id}))
        receipt(self.root, {"event": "pg-control", "scenario": self.name, "mode": mode, "job_id": job_id})

    def pg_events(self):
        path = self.root / "pg-events.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def clock_age(self, command, days):
        self.check_databases()
        before = self.row(command)
        for role in (*ROLES, "replacement"):
            stop_role(self.root, self.environment, role)
        self.sql("BEGIN; SET LOCAL session_replication_role=replica; "
            "UPDATE device_upload_finalization_job SET "
            f"created_at=created_at-interval '{days} days',updated_at=updated_at-interval '{days} days',"
            f"finished_at=finished_at-interval '{days} days' WHERE id='{command['job_id']}'; COMMIT;")
        after = self.row(command)
        created = shared.datetime.fromisoformat(after["created_at"])
        updated = shared.datetime.fromisoformat(after["updated_at"])
        finished = shared.datetime.fromisoformat(after["finished_at"]) if after["finished_at"] else None
        require(updated >= created and (finished is None or finished >= created)
                and after["status"] == before["status"] and after["result"] == before["result"],
                "Clock fixture violated timestamp order or changed terminal semantics")
        receipt(self.root, {"event": "fixture-clock", "scenario": self.name, "job_id": command["job_id"],
                            "age_days": days, "created_at": after["created_at"], "updated_at": after["updated_at"],
                            "finished_at": after["finished_at"],
                            "method": "owned stopped-child database timestamp fixture; no real-day soak"})
        for role in ROLES:
            spawn(self.root, self.environment, role)

    def run(self, name):
        require(name in (*PHASE7, *PHASE8, *PHASE9), f"{name} belongs to a later phase and is not implemented; no passing receipt emitted")
        self.name = name
        self.login()
        receipt(self.root, {"event": "scenario-start", "scenario": name})
        try:
            getattr(self, name.replace("-", "_"))()
        except Exception as error:
            receipt(self.root, {"event": "scenario-failed", "scenario": name, "error": str(error),
                "owned_processes_retained": {role: entry["pid"] for role, entry in self.environment["processes"].items()
                    if shared.owned_process(entry, self.root, self.environment)},
                "cleanup": f"stop --root {self.root}"})
            raise
        finally:
            self.control("normal")
            self.pg_control("normal")
            for role, record in self.environment["processes"].items():
                if shared.owned_process(record, self.root, self.environment):
                    shared.signal_group(record, signal.SIGCONT)
        receipt(self.root, {"event": "scenario-passed", "scenario": name})
        print(name, "passed; receipts:", self.root / "receipts.jsonl")

    @staticmethod
    def source_digest(path):
        with path.open("rb") as source:
            return hashlib.file_digest(source, "sha256").hexdigest()

    @staticmethod
    def rust_limit(path, constant):
        text = (shared.REPO / path).read_text()
        match = re.search(r"\bconst " + re.escape(constant) + r": [^=]+?=\s*([0-9_*\s]+);", text)
        require(match, f"Cannot read exact runtime limit {constant}")
        return math.prod(int(part.strip().replace("_", "")) for part in match[1].split("*"))

    def upload_limit(self, kind):
        if kind == "file":
            return self.rust_limit("wdintel-rs/src/devices/config.rs", "DEVICE_FILE_CONTENT_UPLOAD_MAX_BYTES")
        return self.rust_limit("wdintel-rs/src/devices/audio/mod.rs", "DEVICE_AUDIO_MAX_BYTES")

    def setting(self, key):
        settings = tomllib.loads((self.root / "config-a.toml").read_text())["device_upload_finalization"]
        return settings.get(key, self.rust_limit("wdintel-rs/src/config.rs", "DEVICE_UPLOAD_FINALIZATION_" + key.upper()))

    def resource_snapshot(self, label):
        value = json.loads(self.sql("""SELECT json_build_object(
            'budgets',(SELECT coalesce(json_agg(b),'[]') FROM device_upload_finalization_budget b),
            'jobs',(SELECT coalesce(json_agg(j),'[]') FROM (SELECT id,kind,status,created_by_login_id,
                source_size_bytes,source_locator,source_release_state,quota_released_at,next_run_at,
                lease_epoch,attempt_count FROM device_upload_finalization_job) j),
            'credits',(SELECT coalesce(json_agg(a),'[]') FROM (SELECT kind,count(*) AS held
                FROM device_upload_finalization_attempt WHERE write_credit_held GROUP BY kind) a));"""))
        expected = {}
        for job in value["jobs"]:
            if job["quota_released_at"] is None:
                for scope in (f"global:{job['kind']}", f"actor:{job['created_by_login_id']}:{job['kind']}"):
                    count, size = expected.get(scope, (0, 0))
                    expected[scope] = (count + 1, size + job["source_size_bytes"])
        credits = {item["kind"]: item["held"] for item in value["credits"]}
        for budget in value["budgets"]:
            scope = budget["scope"]
            kind = scope.rsplit(":", 1)[1]
            group = "global" if scope.startswith("global:") else "actor"
            require((budget["reserved_jobs"], budget["reserved_source_bytes"]) == expected.get(scope, (0, 0)),
                    "Durable source quotas disagree with unreleased jobs")
            require(0 <= budget["reserved_jobs"] <= self.setting(f"{kind}_{group}_jobs")
                    and 0 <= budget["reserved_source_bytes"] <= self.setting(f"{kind}_{group}_bytes"),
                    "Resource quota exceeded")
            if group == "global":
                require(budget["unresolved_writes"] == credits.get(kind, 0)
                        and 0 <= budget["unresolved_writes"] <= self.setting(f"{kind}_unresolved_writes"),
                        "Unresolved write credits leaked or exceeded capacity")
        value["slots"] = {}
        slot_settings = {"file": "file_slots", "audio": "audio_slots", "decode": "decode_slots",
                         "encryption": "encryption_slots", "readback": "readback_slots",
                         "file-encryption": "encryption_slots", "file-readback": "readback_slots"}
        value["slot_limits"] = {}
        for kind, setting in slot_settings.items():
            limit = self.setting(setting)
            value["slot_limits"][kind] = limit
            occupied = []
            directory = self.root / "storage/device-upload-finalization-slots" / kind
            for path in directory.glob("*.lock"):
                with path.open("r+") as guard:
                    try:
                        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        occupied.append(int(path.stem))
            require(all(0 <= index < limit for index in occupied), "Shared slot bound exceeded")
            value["slots"][kind] = occupied
        pids = {record["pid"] for record in self.environment["processes"].values()
                if shared.owned_process(record, self.root, self.environment)}
        processes = subprocess.run(["ps", "-axo", "pid=,ppid=,rss=,pcpu="], text=True, capture_output=True, check=True)
        rows = [[int(pid), int(parent), int(rss), float(cpu)] for pid, parent, rss, cpu in
                (line.split() for line in processes.stdout.splitlines())]
        while True:
            descendants = {pid for pid, parent, _, _ in rows if parent in pids}
            if descendants <= pids:
                break
            pids |= descendants
        value["processes"] = [{"pid": pid, "parent": parent, "rss_kib": rss, "cpu_percent": cpu}
                              for pid, parent, rss, cpu in rows if pid in pids]
        value["disk_free_bytes"] = shared.shutil.disk_usage(self.root).free
        receipt(self.root, {"event": "resource-snapshot", "scenario": self.name, "label": label, **value})
        return value

    def source_evidence(self, command):
        self.source_intact(command)
        path = self.source(command)
        info = path.stat()
        receipt(self.root, {"event": "retained-source", "scenario": self.name,
            "job_id": command["job_id"], "kind": command["kind"], "maximum": command.get("maximum", False),
            "bytes": info.st_size, "allocated_bytes": info.st_blocks * 512,
            "sha256": command["payload_sha256"], "device": info.st_dev, "inode": info.st_ino})

    def concurrent_admissions(self, commands):
        require(len(commands) <= CONCURRENCY, "Admission wave exceeds concurrency contract")
        barrier = threading.Barrier(len(commands))
        def admit(index, command):
            require(not command.get("maximum") or len(commands) == CONCURRENCY,
                    "Maximum-size admission requires 32 concurrent commands")
            barrier.wait(timeout=15)
            begin = time.monotonic_ns()
            value = self.accept(command, "a" if index % 2 == 0 else "b", 202, measured=True)
            elapsed = (time.monotonic_ns() - begin) / 1_000_000_000
            require(value["status"] == "queued", "New admission did not return queued")
            sample = {"kind": command["kind"], "job_id": command["job_id"], "upload_id": command["upload_id"],
                      "bytes": command["payload_size"], "maximum": command.get("maximum", False),
                      "seconds": elapsed, "start_monotonic_ns": begin, "concurrency": len(commands)}
            receipt(self.root, {"event": "admission-latency", "scenario": self.name, **sample})
            return sample
        with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
            futures = [executor.submit(admit, index, command) for index, command in enumerate(commands)]
            return [future.result() for future in futures]

    def hold_heavy_workers(self, seeds=None):
        stop_role(self.root, self.environment, "bgworker")
        file = seeds[0] if seeds else self.upload("file")
        self.accept(file, expected=202)
        self.arm("bgworker", "storage_verified", file["job_id"])
        spawn(self.root, self.environment, "bgworker")
        self.reached("bgworker", "storage_verified")
        self.arm("bgworker", "storage_written")
        audio = seeds[1] if seeds else self.upload("audio")
        self.accept(audio, expected=202)
        self.reached("bgworker", "storage_written")
        snapshot = self.resource_snapshot("both-heavy-workers-paused")
        require(snapshot["slots"]["file"] == [0] and snapshot["slots"]["audio"] == [0],
                "Both kind heavy slots must be occupied by actual workers")
        return [file, audio], time.monotonic()

    def release_heavy_workers(self, began):
        remaining = HEAVY_DELAY_SECONDS - (time.monotonic() - began)
        if remaining > 0:
            time.sleep(remaining)
        delay = time.monotonic() - began
        receipt(self.root, {"event": "heavy-worker-delay", "scenario": self.name,
                            "actual_seconds": delay, "required_seconds": HEAVY_DELAY_SECONDS})
        require(delay >= HEAVY_DELAY_SECONDS, "Heavy worker delay was shorter than 30 seconds")
        self.clear("bgworker", "storage_written")
        self.clear("bgworker", "storage_verified")
        return time.monotonic()

    def scheduler_evidence(self, commands, released, prior_attempts=None):
        prior_attempts = prior_attempts or {}
        pending = {command["job_id"] for command in commands}
        while pending and time.monotonic() - released <= SCHEDULER_SECONDS:
            ids = ",".join(f"'{identity}'" for identity in pending)
            rows = json.loads(self.sql("SELECT coalesce(json_agg(j),'[]') FROM "
                f"(SELECT id,status,attempt_count,next_run_at FROM device_upload_finalization_job WHERE id IN ({ids})) j;"))
            for row in rows:
                if row["attempt_count"] > prior_attempts.get(row["id"], 0):
                    latency = time.monotonic() - released
                    require(latency <= SCHEDULER_SECONDS, "Eligible job observation exceeded 60 seconds")
                    receipt(self.root, {"event": "eligible-job-start", "scenario": self.name,
                        "job_id": row["id"], "observed_seconds_after_capacity": latency,
                        "status": row["status"], "attempt_count": row["attempt_count"], "next_run_at": row["next_run_at"]})
                    pending.remove(row["id"])
            if pending:
                time.sleep(0.2)
        require(not pending, f"Eligible due jobs did not start within 60 seconds: {sorted(pending)}")

    def drain_sources(self, commands):
        for command in commands:
            self.completed(command, seconds=180)
        ids = ",".join(f"'{command['job_id']}'" for command in commands)
        until(lambda: self.sql("SELECT count(*) FROM device_upload_finalization_job "
              f"WHERE id IN ({ids}) AND (source_release_state<>'released' OR quota_released_at IS NULL);") == "0",
              90, "terminal source and quota release")

    def prepare_performance_rate_budget(self):
        self.check_databases()
        query = ("SELECT row_to_json(s) FROM (SELECT id,api_rate_limit_replenish_interval_ms,"
                 "api_rate_limit_burst_size,updated_at FROM system_settings WHERE NOT deleted "
                 "ORDER BY updated_at DESC LIMIT 1) s;")
        before = json.loads(self.sql(query, files=False))
        require(before["api_rate_limit_replenish_interval_ms"] == 500,
                "Performance fixture expects the existing 500 ms throttle interval")
        self.sql("UPDATE system_settings SET api_rate_limit_burst_size=32,updated_at=clock_timestamp() "
                 "WHERE NOT deleted;", files=False)
        after = json.loads(self.sql(query, files=False))
        require(after["api_rate_limit_burst_size"] == 32
                and after["api_rate_limit_replenish_interval_ms"] == 500,
                "Owned performance rate budget was not provisioned")
        begin = time.monotonic()
        time.sleep(2)
        probes = {}
        for role in ("a", "b"):
            probe_begin = time.monotonic()
            for _ in range(32):
                self.request("/api/ping", method="GET", role=role, expected=200, rate_retries=0)
            elapsed = time.monotonic() - probe_begin
            require(elapsed < 13.5, "Throttle reload probes could be explained by the old burst5 capacity")
            probes[role] = {"count": 32, "elapsed_seconds": elapsed, "old_burst5_minimum_seconds": 13.5}
        receipt(self.root, {"event": "performance-rate-budget", "scenario": self.name,
            "before": before, "after": after, "cache_wait_seconds": 2,
            "cache_wait_and_probe_actual_seconds": time.monotonic() - begin,
            "authenticated_probe_count_per_api": 32, "probe_elapsed_per_api": probes,
            "measured_commands_per_api": CONCURRENCY // 2,
            "actors": 1, "note": "Configured owned load fixture; not default-throttle burst proof"})
        return after

    def refill_performance_rate_budget(self, settings):
        seconds = settings["api_rate_limit_burst_size"] * settings["api_rate_limit_replenish_interval_ms"] / 1000
        begin = time.monotonic()
        time.sleep(seconds)
        receipt(self.root, {"event": "performance-rate-refill", "scenario": self.name,
            "required_seconds": seconds, "actual_seconds": time.monotonic() - begin,
            "available_tokens_per_api_at_least": settings["api_rate_limit_burst_size"],
            "measured_commands_per_api": CONCURRENCY // 2})

    def prepare_performance_tail(self, first_offset, maximum_index):
        waves = {}
        seeds = {}
        for offset in range(first_offset, ADMISSIONS_PER_KIND, CONCURRENCY // 2):
            count = min(CONCURRENCY // 2, ADMISSIONS_PER_KIND - offset)
            waves[offset] = [self.upload(kind) for index in range(count)
                             if offset + index != maximum_index for kind in ("file", "audio")]
            seeds[offset] = [self.upload(kind) for kind in ("file", "audio")]
        maximum_audio = self.upload("audio", maximum=True)
        maximum_file = self.upload("file", maximum=True)
        waves[first_offset].extend([maximum_file, maximum_audio])
        receipt(self.root, {"event": "performance-tail-prepared", "scenario": self.name,
            "waves": {offset: {"commands": len(commands), "seeds": len(seeds[offset])}
                      for offset, commands in waves.items()},
            "file_source_count": sum(sum(c["kind"] == "file" for c in commands) + 1 for commands in waves.values()),
            "maximum_file_upload_id": maximum_file["upload_id"],
            "note": "All remaining small/seed sources prepared before maximum file bytes; no later TUS creation"})
        return waves, seeds

    def performance(self):
        rate_settings = self.prepare_performance_rate_budget()
        receipt(self.root, {"event": "performance-conditions", "scenario": self.name,
            "admissions_per_kind": ADMISSIONS_PER_KIND, "concurrency": CONCURRENCY,
            "heavy_delay_seconds": HEAVY_DELAY_SECONDS, "eligible_start_budget_seconds": SCHEDULER_SECONDS,
            "maximum_bytes": {kind: self.upload_limit(kind) for kind in ("file", "audio")},
            "p95_budget_seconds": 1, "p99_budget_seconds": 2, "binary_sha256": self.source_digest(BINARY),
            "maximum_file_publication": "not exercised; locked admission-only source"})
        samples = []
        retained = []
        maximum_index = ADMISSIONS_PER_KIND - ADMISSIONS_PER_KIND % (CONCURRENCY // 2) - 1
        maximum_wave = maximum_index // (CONCURRENCY // 2) * (CONCURRENCY // 2)
        tail_waves, tail_seeds = {}, {}
        try:
            for offset in range(0, ADMISSIONS_PER_KIND, CONCURRENCY // 2):
                count = min(CONCURRENCY // 2, ADMISSIONS_PER_KIND - offset)
                if offset == maximum_wave:
                    tail_waves, tail_seeds = self.prepare_performance_tail(offset, maximum_index)
                commands = tail_waves[offset] if offset in tail_waves else [
                    self.upload(kind) for index in range(count) for kind in ("file", "audio")]
                seeds, began = self.hold_heavy_workers(tail_seeds.get(offset))
                before = self.resource_snapshot(f"wave-{offset}-before")
                for kind in ("file", "audio"):
                    global_budget = next(b for b in before["budgets"] if b["scope"] == f"global:{kind}")
                    incoming = [command for command in commands if command["kind"] == kind]
                    require(global_budget["reserved_jobs"] + len(incoming) <= self.setting(f"{kind}_actor_jobs")
                            and global_budget["reserved_source_bytes"] + sum(c["payload_size"] for c in incoming)
                            <= min(self.setting(f"{kind}_actor_bytes"), self.setting(f"{kind}_global_bytes")),
                            "Measured admissions would exceed fixture quotas")
                self.refill_performance_rate_budget(rate_settings)
                samples.extend(self.concurrent_admissions(commands))
                for command in commands:
                    self.source_evidence(command)
                    if command["kind"] == "file" and command.get("maximum"):
                        lock = self.root / "storage/device-file-content-spool" / f"{command['upload_id']}.lock"
                        guard = lock.open("r+")
                        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        retained.append((command, guard))
                self.resource_snapshot(f"wave-{offset}-accepted")
                released = self.release_heavy_workers(began)
                self.scheduler_evidence(commands, released)
                draining = [command for command in commands if not (command["kind"] == "file" and command.get("maximum"))]
                self.drain_sources([*seeds, *draining])
                self.resource_snapshot(f"wave-{offset}-drained")
            for kind in ("file", "audio"):
                maximum_samples = [sample for sample in samples if sample["kind"] == kind and sample["maximum"]]
                require(len(maximum_samples) == 1 and maximum_samples[0]["concurrency"] == CONCURRENCY
                        and maximum_samples[0]["bytes"] == self.upload_limit(kind),
                        "Missing exact maximum-size representative under 32-command concurrency")
                values = sorted(sample["seconds"] for sample in samples if sample["kind"] == kind)
                p95, p99 = (values[math.ceil(len(values) * q) - 1] for q in (0.95, 0.99))
                receipt(self.root, {"event": "admission-distribution", "scenario": self.name, "kind": kind,
                    "count": len(values), "p95_seconds": p95, "p99_seconds": p99, "raw_seconds": values,
                    "max_concurrency": max(s["concurrency"] for s in samples), "percentile_method": "nearest-rank"})
                require(len(values) >= ADMISSIONS_PER_KIND and p95 <= 1 and p99 <= 2,
                        f"{kind} admission threshold failed: n={len(values)} P95={p95} P99={p99}")
        finally:
            if retained:
                for role in (*ROLES, "replacement"):
                    stop_role(self.root, self.environment, role, crash=True)
                for command, guard in retained:
                    self.source_evidence(command)
                    guard.close()
                receipt(self.root, {"event": "maximum-admission-only", "scenario": self.name,
                    "note": "Owned apps stopped before releasing maximum-file source lock; max-file publication untested"})

    def resource_bounds(self):
        seeds, began = self.hold_heavy_workers()
        commands = [self.upload(kind) for kind in ("file", "audio")]
        self.concurrent_admissions(commands)
        before = self.resource_snapshot("before-worker-suspension")
        original = self.environment["processes"]["bgworker"]
        shared.signal_group(original, signal.SIGSTOP)
        try:
            spawn(self.root, self.environment, "replacement")
            time.sleep(self.setting("lease_seconds") + 2)
            after = self.resource_snapshot("replacement-cannot-reuse-live-child-slots")
            require(before["slots"]["file"] == after["slots"]["file"] == [0]
                    and before["slots"]["audio"] == after["slots"]["audio"] == [0],
                    "Lease expiry released resources still held by a real process")
            for command in [*seeds, *commands]:
                self.source_evidence(command)
            stop_role(self.root, self.environment, "replacement")
        finally:
            shared.signal_group(original, signal.SIGCONT)
            released = self.release_heavy_workers(began)
        self.scheduler_evidence(commands, released)
        self.drain_sources([*seeds, *commands])
        self.control("file-lost-put-response")
        unknowns = []
        try:
            for _ in range(self.setting("file_unresolved_writes")):
                command = self.upload("file")
                self.accept(command, expected=202)
                until(lambda: self.row(command)["status"] == "outcome_unknown", 60, "real unresolved file write")
                self.source_evidence(command)
                unknowns.append(command)
            saturated = self.resource_snapshot("file-write-credits-exhausted")
            budget = next(b for b in saturated["budgets"] if b["scope"] == "global:file")
            require(budget["unresolved_writes"] == self.setting("file_unresolved_writes"),
                    "Write credit fixture did not actually reach configured capacity")
            waiting, healthy = self.upload("file"), self.upload("audio")
            self.concurrent_admissions([waiting, healthy])
            until(lambda: self.row(waiting)["status"] == "retry_wait", 60, "safe saturated pre-write retry")
            self.source_evidence(waiting)
            require(self.storage_puts(waiting) == 0, "Saturated credit lane dispatched an extra write")
            self.scheduler_evidence([healthy], time.monotonic())
            self.drain_sources([healthy])
            held = self.resource_snapshot("healthy-audio-completed-with-file-credits-exhausted")
            require(next(b for b in held["budgets"] if b["scope"] == "global:file")["unresolved_writes"]
                    == self.setting("file_unresolved_writes"), "Other-kind proof lost its saturated condition")
            for command in unknowns:
                self.source_evidence(command)
            prior_attempts = {waiting["job_id"]: self.row(waiting)["attempt_count"]}
        finally:
            self.control("normal")
        released = time.monotonic()
        self.scheduler_evidence([waiting], released, prior_attempts)
        self.drain_sources([*unknowns, waiting])
        for command in unknowns:
            require(self.storage_puts(command) == 1, "Reserved reconciliation dispatched a duplicate remote write")
        self.resource_snapshot("all-resource-reservations-released")

    def source_pin(self):
        for kind in ("file", "audio"):
            for boundary in ("file_source_durable" if kind == "file" else "audio_source_pinned",
                             f"{kind}_admission_committed"):
                stop_role(self.root, self.environment, "bgworker")
                command = self.upload(kind)
                self.arm("api-a", boundary, command["upload_id"])
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    pending = executor.submit(self.accept, command)
                    self.reached("api-a", boundary)
                    stop_role(self.root, self.environment, "api-a", True)
                    self.clear("api-a", boundary)
                    try:
                        pending.result(timeout=10)
                    except (OSError, urllib.error.URLError):
                        pass
                spawn(self.root, self.environment, "api-a")
                if boundary == "audio_source_pinned":
                    self.recover_audio_orphan(command)
                self.accept(command, "b", 202)
                self.source_intact(command)
                self.request(command["location"], method="DELETE", headers={"Tus-Resumable": "1.0.0"},
                             role="b", expected=(409, 423, 503))
                self.request(command["location"], b"x", "PATCH", {"Tus-Resumable": "1.0.0",
                             "Upload-Offset": str(command["payload_size"]), "Content-Type": "application/offset+octet-stream"},
                             role="b", expected=(409, 423, 503))
                self.source_intact(command)
                self.restart("api-a")
                self.restart("api-b")
                spawn(self.root, self.environment, "bgworker")
                self.completed(command)

    def recover_audio_orphan(self, command):
        tus = self.root / "storage/device-audio-tus" / command["device"] / "file_upload_tus"
        marker = tus / "pins" / f"{command['upload_id']}.json"
        proof = tus / "locks" / command["upload_id"]
        sources = list((tus / "completed").rglob(f"{command['upload_id']}.{command['payload_size']}"))
        require(len(sources) == 1 and marker.is_file() and proof.stat().st_size > 0,
                "Killed pre-admission child did not leave one protected audio source")
        source = sources[0]
        intact = lambda: source.is_file() and self.source_digest(source) == command["payload_sha256"]
        require(intact(), "Orphan audio source changed after child exit")
        count = self.sql("SELECT count(*) FROM device_upload_finalization_job WHERE kind='audio' AND "
                         f"source_identity='{command['device']}/{command['upload_id']}';")
        require(count == "0", "Pre-admission crash unexpectedly committed an audio job")
        self.request(command["path"], command["body"], role="b", expected=503)
        require(intact() and marker.is_file(), "Unavailable orphan ownership proof lost protected bytes")
        history = self.seed_lock_history(command, tus / "locks")
        begin = time.monotonic()
        spawn(self.root, self.environment, "bgworker")
        until(lambda: not marker.exists() and (not proof.exists() or proof.stat().st_size == 0),
              max(0.1, 15 - (time.monotonic() - begin)),
              "automatic audio orphan-pin recovery amid retained lock history without status GET")
        elapsed = time.monotonic() - begin
        require(elapsed <= 15, "Owned orphan recovery exceeded its 15-second fixture budget")
        stop_role(self.root, self.environment, "bgworker")
        require(intact(), "Orphan-pin recovery removed unaccepted audio bytes")
        receipt(self.root, {"event": "orphan-recovered", "scenario": self.name,
                           "upload_id": command["upload_id"], "job_count_before": 0, "source_preserved": True,
                           "retained_empty_lock_count": history, "recovery_seconds": elapsed,
                           "fixture_budget_seconds": 15, "production_latency_claim": False})

    def seed_lock_history(self, command, directory):
        namespace = uuid.UUID(command["upload_id"])
        for index in range(2000):
            path = directory / str(uuid.uuid5(namespace, f"phase7-history-{index}"))
            with path.open("x"):
                pass
        count = sum(path.is_file() and path.stat().st_size == 0 for path in directory.iterdir())
        require(count >= 2000, "Retained-lock fixture did not create its owned history")
        receipt(self.root, {"event": "retained-lock-history", "scenario": self.name,
                           "upload_id": command["upload_id"], "created_empty_locks": 2000,
                           "observed_empty_locks": count, "directory": str(directory)})
        return count

    def storage_recovery(self):
        for kind in ("file", "audio"):
            command = self.upload(kind)
            self.arm("bgworker", "write_intent")
            self.accept(command, expected=202)
            self.reached("bgworker", "write_intent")
            self.control("lost-put-response")
            self.clear("bgworker", "write_intent")
            until(lambda: self.row(command)["status"] == "outcome_unknown", 60, "unknown remote-write outcome")
            self.source_intact(command)
            before = self.storage_puts(command)
            self.clock_age(command, 25 / 24)
            time.sleep(3)
            self.source_intact(command)
            require(self.row(command)["status"] == "outcome_unknown", "Unavailable proof was treated as terminal")
            require(self.storage_puts(command) == before, "Unresolved remote write was blindly dispatched again")
            held = self.sql(f"SELECT count(*) FROM device_upload_finalization_attempt WHERE job_id='{command['job_id']}' AND write_credit_held;")
            require(held == "1", "Unknown write did not retain one durable credit")
            self.control("normal")
            self.completed(command)
            require(self.storage_puts(command) == before, "Reconciliation unnecessarily rewrote the object")
            self.safe_retry(kind)

    def safe_retry(self, kind):
        directory = self.root / "storage/device-upload-finalization-slots" / kind
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (directory / "0.lock").open("a+") as guard:
            def acquire():
                try:
                    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return True
                except BlockingIOError:
                    return False
            until(acquire, 15, "preceding finalizer slot release")
            command = self.upload(kind)
            self.accept(command, expected=202)
            until(lambda: self.row(command)["status"] == "retry_wait", 30, "safe pre-write capacity retry")
            self.source_intact(command)
            self.clock_age(command, 25 / 24)
            until(lambda: self.row(command)["status"] == "retry_wait", 30, "safe retry after simulated 25 hours and real restart")
            self.source_intact(command)
            require(self.storage_puts(command) == 0, "Safe pre-write retry dispatched a remote write")
        self.completed(command)

    def storage_puts(self, command):
        attempt_keys = self.sql(f"SELECT object_key FROM device_upload_finalization_attempt WHERE job_id='{command['job_id']}';").splitlines()
        events = (self.root / "storage-events.jsonl").read_text().splitlines()
        return sum(event["method"] == "PUT" and any(event["path"].endswith("/" + key) for key in attempt_keys)
                   for event in map(json.loads, events))

    def publication(self):
        for kind in ("file", "audio"):
            self.commit_response_loss(kind)
        for kind in ("file", "audio"):
            command = self.upload(kind)
            self.arm("bgworker", f"{kind}_publication_committed")
            self.accept(command, expected=202)
            self.reached("bgworker", f"{kind}_publication_committed")
            before = self.row(command)
            require(before["status"] == "completed", "Publication boundary lacks atomic terminal receipt")
            stop_role(self.root, self.environment, "bgworker", True)
            self.clear("bgworker", f"{kind}_publication_committed")
            spawn(self.root, self.environment, "bgworker")
            after = self.completed(command)
            require(before["result"] == after["result"] and before["winning_attempt_id"] == after["winning_attempt_id"],
                    "Restart changed committed publication")
            replay = self.accept(command, "b", 200)
            require(replay["status"] == "completed", "Committed command replay lost success")
        for kind in ("file", "audio"):
            command = self.upload(kind)
            self.arm("bgworker", "storage_verified")
            self.accept(command, expected=202)
            self.reached("bgworker", "storage_verified")
            self.sql(f"UPDATE device SET archived=true,archived_at=clock_timestamp() WHERE id='{command['device']}';", files=False)
            self.clear("bgworker", "storage_verified")
            self.completed(command, "failed")

    def commit_response_loss(self, kind):
        command = self.upload(kind)
        self.arm("bgworker", "storage_verified")
        self.accept(command, expected=202)
        self.reached("bgworker", "storage_verified")
        self.pg_control("drop-commit-and-block", command["job_id"])
        self.clear("bgworker", "storage_verified")
        def committed():
            return next((event for event in self.pg_events() if event["event"] == "commit_ack_suppressed"
                         and event["job_id"] == command["job_id"]), None)
        event = until(committed, 60, "actual backend COMMIT with lost transport acknowledgement")
        receipt(self.root, {**event, "event": "publication-commit-transport-loss", "scenario": self.name})
        before = self.row(command)
        require(before["status"] == "completed", "Lost COMMIT acknowledgement lacks committed own publication")
        self.source_intact(command)
        stop_role(self.root, self.environment, "bgworker", True)
        previous = len(self.pg_events())
        spawn(self.root, self.environment, "bgworker")
        until(lambda: any(event["event"] in ("query_unavailable", "connection_unavailable")
                         for event in self.pg_events()[previous:]), 30, "actual unavailable publication-proof connection")
        self.source_intact(command)
        stop_role(self.root, self.environment, "bgworker", True)
        self.pg_control("normal")
        spawn(self.root, self.environment, "bgworker")
        after = self.completed(command)
        require(before["result"] == after["result"] and before["winning_attempt_id"] == after["winning_attempt_id"],
                "Commit-response reconciliation changed its own publication")
        until(lambda: self.row(command)["source_release_state"] == "released", 90,
              "automatic cleanup/accounting after publication-proof recovery without GET")

    def fencing(self):
        for kind in ("file", "audio"):
            command = self.upload(kind)
            self.arm("bgworker", "storage_written")
            self.accept(command, expected=202)
            self.reached("bgworker", "storage_written")
            old = self.row(command)
            record = self.environment["processes"]["bgworker"]
            require(shared.owned_process(record, self.root, self.environment), "Lost worker ownership")
            shared.signal_group(record, signal.SIGSTOP)
            try:
                self.sql(f"UPDATE device_upload_finalization_job SET lease_until=clock_timestamp()-interval '1 second' WHERE id='{command['job_id']}';")
                spawn(self.root, self.environment, "replacement")
                until(lambda: self.row(command)["lease_epoch"] > old["lease_epoch"], 30, "actual replacement lease takeover")
                self.clear("bgworker", "storage_written")
            finally:
                shared.signal_group(record, signal.SIGCONT)
            row = self.completed(command)
            require(row["lease_epoch"] > old["lease_epoch"], "Stale worker retained its fence")
            stop_role(self.root, self.environment, "replacement")
            require(self.storage_puts(command) == 1, "Lease takeover created a second ambiguous remote write")

    def post_publication(self):
        for kind in ("file", "audio"):
            command = self.upload(kind)
            self.arm("bgworker", f"{kind}_source_removed")
            self.accept(command, expected=202)
            self.reached("bgworker", f"{kind}_source_removed")
            require(self.row(command)["status"] == "completed", "Cleanup ran before durable success")
            require(not self.source(command).exists(), "Cleanup boundary did not remove source")
            if kind == "audio":
                parent = self.source(command).parent
                info = parent.stat()
                require((info.st_dev, info.st_ino) == command["source_directory_identity"]
                        and (parent / ".finalization").is_file(),
                        "Audio cleanup did not preserve its original source directory with a durable anchor")
                receipt(self.root, {"event": "audio-cleanup-directory-preserved", "scenario": self.name,
                                   "job_id": command["job_id"], "device": info.st_dev, "inode": info.st_ino,
                                   "anchor": ".finalization"})
            stop_role(self.root, self.environment, "bgworker", True)
            self.clear("bgworker", f"{kind}_source_removed")
            spawn(self.root, self.environment, "bgworker")
            self.completed(command)
            until(lambda: self.row(command)["source_release_state"] == "released", 60, "post-crash cleanup accounting repair")
            self.clock_age(command, 31)
            first = self.accept(command, "b", 200)
            self.restart("api-a")
            self.restart("api-b")
            self.restart("bgworker")
            second = self.accept(command, "a", 200)
            require(first == second and second["status"] == "completed", "Terminal replay changed after 31-day fixture and restart")
            self.completed(command)

    def rollout_admission(self, enabled):
        self.check_databases()
        for role in (*ROLES, "replacement"):
            stop_role(self.root, self.environment, role)
        for role in ("a", "b"):
            path = self.root / f"config-{role}.toml"
            config = tomllib.loads(path.read_text())
            config["device_upload_finalization"]["enabled"] = enabled
            text = shared.toml_text(config)
            shared.private_write(path, text)
            self.environment["config_hashes"][role] = hashlib.sha256(text.encode()).hexdigest()
        shared.save(self.root, self.environment)
        load(self.root)
        receipt(self.root, {"event": "rollout-admission", "scenario": self.name,
            "enabled": enabled, "all_owners_stopped_before_config_change": True})

    def rollout_owners(self):
        configs = [tomllib.loads((self.root / f"config-{role}.toml").read_text()) for role in ("a", "b")]
        for config in configs:
            require(config["storage_dir"] == str(self.root / "storage")
                    and config["file_registry"] == configs[0]["file_registry"]
                    and config["s3_config"] == configs[0]["s3_config"]
                    and config["device_upload_finalization"] == configs[0]["device_upload_finalization"],
                    "Owners disagree on persistent root, database, keys, bucket, or finalization settings")
        owners = {}
        binary_hash = self.source_digest(BINARY)
        for role in ROLES:
            record = self.environment["processes"].get(role)
            require(record and shared.owned_process(record, self.root, self.environment),
                    f"Missing upgraded owned {role}")
            until(lambda: shared.observe(["ps", "-p", str(record["pid"]), "-o", "args="]).startswith(str(BINARY) + " "),
                  15, "owner exec of the selected current binary")
            owners[role] = {"pid": record["pid"], "started": record["started"], "binary_sha256": binary_hash}
        require(self.sql("SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN "
            "('file_content_00_register_object_trg','file_content_upload_finalization_trg',"
            "'device_upload_finalization_bind_file_trg');") == "3", "Required schema/ownership guards are missing")
        receipt(self.root, {"event": "rollout-owner-prerequisites", "scenario": self.name,
            "owners": owners, "config_hashes": self.environment["config_hashes"],
            "storage_device": (self.root / "storage").stat().st_dev,
            "shared_root_keys_bucket_database_settings": True, "media_tools": ["ffmpeg", "ffprobe"],
            "old_cleaners_run": False,
            "limits": "Current binary on one host/local filesystem; fleet inventory, network mounts and old binaries untested"})

    def rollout_schema_writer(self):
        command = self.upload("file")
        writer = ("UPDATE file_content_upload SET status='completed',next_cleanup_at=clock_timestamp() "
            f"WHERE id='{command['upload_id']}'; "
            "INSERT INTO file_content(file_id,revision,upload_id,object_key,source_size_bytes,source_sha256,is_encrypted,created_at) "
            "SELECT file_id,revision,id,object_key,upload_length,expected_sha256,true,clock_timestamp() "
            f"FROM file_content_upload WHERE id='{command['upload_id']}'; ")
        registered = self.sql("BEGIN; " + writer + "SELECT count(*) FROM file_content_upload_object o "
            f"JOIN file_content_upload u ON u.id=o.upload_id WHERE u.id='{command['upload_id']}' "
            "AND o.attempt_id IS NULL AND o.object_key=u.object_key; ROLLBACK;")
        require(registered == "1", "Old-column canonical INSERT did not register selected provenance")
        require(self.sql(f"SELECT status FROM file_content_upload WHERE id='{command['upload_id']}';") == "open",
                "Old-writer SQL probe was not rolled back")
        _, published, _ = self.request(command["path"], {}, headers={"Content-Type": "application/json",
            "Tus-Resumable": "1.0.0"}, expected=200)
        require(published["status"] == "completed" and published["upload_id"] == command["upload_id"],
                "Synchronous writer contract changed with migrated schema and disabled admission")
        canonical = self.sql("SELECT count(*) FROM file_content c JOIN file_content_upload u ON u.id=c.upload_id "
            "JOIN file_content_upload_object o ON o.upload_id=c.upload_id "
            f"WHERE u.id='{command['upload_id']}' AND u.status='completed' AND c.object_key=u.object_key "
            "AND o.object_key=c.object_key AND o.attempt_id IS NULL AND u.finalization_job_id IS NULL;")
        require(canonical == "1" and self.sql("SELECT count(*) FROM device_upload_finalization_job;") == "0",
                "Canonical sync publication gained async ownership or lost provenance")
        receipt(self.root, {"event": "rollout-schema-first-writer", "scenario": self.name,
            "upload_id": command["upload_id"], "old_column_insert_auto_registered": True,
            "sql_probe_rolled_back": True, "sync_http_status": 200, "async_jobs": 0,
            "limits": "Actual old-column SQL and current sync executable; no pre-upgrade executable or cleaner"})

    def rollout_downgrade(self, label, version, expected_error):
        self.check_databases()
        path = shared.REPO / "wdfiles-migration/src" / f"{version}.rs"
        text = path.read_text().split("async fn down(", 1)[1]
        sql = re.search(r'execute_unprepared\(\s*r#"(.*?)"#', text, re.DOTALL)
        require(sql, "Cannot extract exact migration DOWN SQL")
        snapshot = "SELECT json_build_object('versions',(SELECT json_agg(version ORDER BY version) FROM seaql_migrations)," \
            "'jobs',(SELECT count(*) FROM device_upload_finalization_job),'objects',(SELECT count(*) FROM file_content_upload_object)," \
            "'contents',(SELECT count(*) FROM file_content));"
        before = self.sql(snapshot)
        result = subprocess.run(["psql", "-q", "-X", "-At", "-v", "ON_ERROR_STOP=1"],
            env=shared.postgres_env(self.root, self.environment, self.environment["files_db"]),
            input="BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'; " + sql[1] + " ROLLBACK;",
            text=True, capture_output=True, timeout=10)
        shared.private_write(self.root / f"rollout-down-{label}.log", result.stdout + result.stderr)
        require(result.returncode != 0 and expected_error in result.stderr,
                f"DOWN {label} did not refuse for its data safeguard; inspect its private log")
        require(self.sql(snapshot) == before, "Rejected DOWN changed migration versions or publication/history counts")
        receipt(self.root, {"event": "rollout-downgrade-refused", "scenario": self.name,
            "label": label, "migration": version, "migration_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "exit_code": result.returncode, "expected_error": expected_error, "snapshot": json.loads(before),
            "method": "Exact migration DOWN SQL in rollback-only transaction; migrator version API tested separately"})

    def rollout_disabled_recovery(self):
        stop_role(self.root, self.environment, "bgworker")
        commands = [self.upload(kind) for kind in ("file", "audio")]
        for command in commands:
            self.accept(command, expected=202)
            self.source_evidence(command)
        self.rollout_admission(False)
        self.rollout_downgrade("active-history", "m20261027_112601_synchronous_finalization_adoption",
                               "cannot downgrade with retained finalization history")
        self.rollout_downgrade("active-core", "m20261014_182354_device_upload_finalization",
                               "cannot downgrade while finalization evidence or noncanonical publications exist")
        for role in ("api-a", "api-b"):
            spawn(self.root, self.environment, role)
        for command in commands:
            original = command["job_id"]
            self.accept(command, role="b", expected=202)
            require(command["job_id"] == original, "Disabled admission changed accepted job identity")
            self.source_intact(command)
        for kind in ("file", "audio"):
            fresh = self.upload(kind)
            count = self.sql("SELECT count(*) FROM device_upload_finalization_job;")
            _, value, headers = self.request(fresh["path"], fresh["body"], expected=503,
                headers={"Content-Type": "application/json", "Tus-Resumable": "1.0.0"})
            has_job = "job_id" in value if isinstance(value, dict) else b"job_id" in value
            require("retry-after" in headers and "no-store" in headers.get("cache-control", "")
                    and not has_job and self.sql("SELECT count(*) FROM device_upload_finalization_job;") == count,
                    "Disabled fresh admission lost retry/privacy semantics or created a job")
            receipt(self.root, {"event": "rollout-new-admission-refused", "scenario": self.name,
                "kind": kind, "status": 503, "job_count_unchanged": True})
        spawn(self.root, self.environment, "bgworker")
        self.rollout_owners()
        self.drain_sources(commands)
        for command in commands:
            replay = self.accept(command, role="b", expected=200)
            require(replay["status"] == "completed", "Disabled terminal replay lost success")
        receipt(self.root, {"event": "rollout-admission-off-recovered", "scenario": self.name,
            "job_ids": [command["job_id"] for command in commands], "status_gets": 0,
            "source_and_quota_released": True})
        return commands

    def rollout_stop(self, kind, crash):
        command = self.upload(kind)
        self.arm("bgworker", "storage_written")
        self.accept(command, expected=202)
        self.reached("bgworker", "storage_written")
        before = self.row(command)
        require(before["status"] == "processing" and self.storage_puts(command) == 1,
                "Stop fixture did not reach actual remote write before publication")
        began = time.monotonic()
        stop_role(self.root, self.environment, "bgworker", crash)
        elapsed = time.monotonic() - began
        self.source_evidence(command)
        self.clear("bgworker", "storage_written")
        spawn(self.root, self.environment, "bgworker")
        row = self.completed(command)
        self.drain_sources([command])
        require(row["lease_epoch"] > before["lease_epoch"] and self.storage_puts(command) == 1,
                "Stopped job did not recover with a new fence and the original remote write")
        receipt(self.root, {"event": "rollout-stop-recovered", "scenario": self.name,
            "kind": kind, "job_id": command["job_id"], "signal": "SIGKILL" if crash else "SIGTERM",
            "stop_seconds": elapsed, "old_lease_epoch": before["lease_epoch"],
            "new_lease_epoch": row["lease_epoch"], "put_count": 1, "status_gets": 0,
            "source_preserved_at_stop": True, "source_and_quota_released_after_recovery": True})
        return command

    def rollout(self):
        require(self.sql("SELECT count(*) FROM device_upload_finalization_job;") == "0",
                "Rollout requires a fresh owned root without prior finalization jobs")
        original = tomllib.loads((self.root / "config-a.toml").read_text())["device_upload_finalization"]["enabled"]
        binary_hash = self.source_digest(BINARY)
        self.rollout_admission(False)
        for role in ("api-a", "api-b"):
            spawn(self.root, self.environment, role)
        self.rollout_schema_writer()
        self.rollout_admission(True)
        for role in ROLES:
            spawn(self.root, self.environment, role)
        self.rollout_owners()
        commands = self.rollout_disabled_recovery()
        self.rollout_admission(True)
        for role in ROLES:
            spawn(self.root, self.environment, role)
        for crash in (False, True):
            for kind in ("file", "audio"):
                commands.append(self.rollout_stop(kind, crash))
        self.rollout_admission(False)
        noncanonical = int(self.sql("SELECT count(*) FROM file_content_upload_object o "
            "JOIN file_content_upload u ON u.id=o.upload_id WHERE o.object_key<>u.object_key AND o.attempt_id IS NOT NULL;"))
        require(noncanonical >= 3, "Rollout did not retain actual noncanonical async file publications")
        self.rollout_downgrade("published-history", "m20261027_112601_synchronous_finalization_adoption",
                               "cannot downgrade with retained finalization history")
        self.rollout_downgrade("published-core", "m20261014_182354_device_upload_finalization",
                               "cannot downgrade while finalization evidence or noncanonical publications exist")
        receipt(self.root, {"event": "rollout-retained-publications", "scenario": self.name,
            "noncanonical_file_publications": noncanonical, "retained_job_count": len(commands),
            "limits": "Core guard also sees retained jobs/attempts; noncanonical-only state is not fabricated"})
        self.resource_snapshot("rollout-drained")
        self.rollout_admission(original)
        for role in ROLES:
            spawn(self.root, self.environment, role)
        self.rollout_owners()
        require(self.source_digest(BINARY) == binary_hash, "Selected binary changed during rollout rehearsal")


def serve_storage(root, environment):
    import logging
    from moto.server import ThreadedMotoServer

    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    backend = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    backend.start()
    host, port = backend.get_host_and_port()
    events_lock = threading.Lock()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    class Proxy(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def do_GET(self):
            self.forward()

        do_HEAD = do_PUT = do_DELETE = do_POST = do_GET

        def forward(self):
            mode = json.loads((root / "storage-control.json").read_text())["mode"]
            if mode == "file-lost-put-response":
                mode = "lost-put-response" if "/device-file-finalization/" in self.path else "normal"
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            status, response_body, headers = 503, b"owned fixture storage unavailable", {}
            deny = mode == "outage" or (mode in ("deny-read", "lost-put-response") and self.command in ("GET", "HEAD"))
            if not deny:
                forwarded = {key: value for key, value in self.headers.items()
                             if key.lower() not in ("host", "connection", "content-length")}
                if body and not self.headers.get("Content-Type"):
                    forwarded["Content-Type"] = "application/octet-stream"
                request = urllib.request.Request(f"http://{host}:{port}{self.path}", data=body if body or self.command in ("PUT", "POST") else None,
                    method=self.command, headers=forwarded)
                try:
                    response = opener.open(request, timeout=30)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    status, response_body, headers = response.status, response.read(), dict(response.headers)
            with events_lock:
                with (root / "storage-events.jsonl").open("a") as output:
                    output.write(json.dumps({"method": self.command, "path": self.path, "mode": mode,
                                             "backend_status": status, "bytes": len(body)}) + "\n")
            if mode == "lost-put-response" and self.command == "PUT" and status in (200, 201, 204):
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.send_response(status)
            for key, value in headers.items():
                if key.lower() not in ("content-length", "connection", "transfer-encoding", "server", "date"):
                    self.send_header(key, value)
            content_length = str(len(response_body))
            if self.command == "HEAD":
                content_length = next((value for key, value in headers.items() if key.lower() == "content-length"), content_length)
            self.send_header("Content-Length", content_length)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(response_body)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", environment["s3_port"]), Proxy)
    server.daemon_threads = True
    try:
        server.serve_forever()
    finally:
        server.server_close()
        backend.stop()


def storage_probe(root, environment):
    import boto3
    from botocore.config import Config

    config = tomllib.loads((root / "config-a.toml").read_text())["s3_config"]
    client = boto3.client("s3", endpoint_url=config["s3_endpoint"], region_name=config["s3_region"],
        aws_access_key_id=config["s3_access_key_id"], aws_secret_access_key=config["s3_secret_access_key"],
        config=Config(signature_version="s3v4", connect_timeout=2, read_timeout=5, proxies={},
                      retries={"max_attempts": 0}, request_checksum_calculation="when_required"))
    bucket = environment["bucket"]
    client.create_bucket(Bucket=bucket)
    probe = secrets.token_bytes(97)
    client.put_object(Bucket=bucket, Key="harness-ownership-probe", Body=probe, ContentType="application/octet-stream")
    response = client.get_object(Bucket=bucket, Key="harness-ownership-probe")
    with response["Body"] as body:
        require(body.read() == probe, "Signed fixture storage byte roundtrip failed")
    client.delete_object(Bucket=bucket, Key="harness-ownership-probe")
    receipt(root, {"event": "storage-probe-passed", "bytes": len(probe), "signature": "s3v4"})


def run_role(root, environment, role):
    if role == "pg-proxy":
        from upload_finalization_pg_proxy import serve
        serve(root, environment)
        return
    if role == "storage":
        serve_storage(root, environment)
        return
    env = runtime_env(root, environment, role)
    if role.startswith("api-"):
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", environment[f"api_{role[-1]}_port"]))
        listener.listen(128)
        os.dup2(listener.fileno(), 3)
        os.set_inheritable(3, True)
        env.update(LISTEN_PID=str(os.getpid()), LISTEN_FDS="1", ECHO_DEV_BACK_REST_ONLY="true")
        os.execve(str(BINARY), [str(BINARY), "--mode=debug", "server", "--no-bgworker"], env)
    os.execve(str(BINARY), [str(BINARY), "--mode=debug", "bgworker"], env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "start", "scenario", "stop", "run-role", "storage-probe"))
    parser.add_argument("--root", help="Private root printed by prepare; never a shared default")
    parser.add_argument("--name", choices=(*PHASE7, *PHASE8, *PHASE9, *LATER, "all"))
    parser.add_argument("--role", choices=(*ROLES, "replacement", "storage", "pg-proxy"))
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "prepare":
        require(not args.root, "Prepare creates a fresh private root and prints its exact path")
        prepare()
        return
    require(args.root, "Supply the exact --root printed by this run's prepare")
    root, environment = load(args.root)
    if args.command == "start":
        start(root, environment)
    elif args.command == "stop":
        for record in environment["processes"].values():
            if shared.owned_process(record, root, environment):
                shared.signal_group(record, signal.SIGCONT)
        shared.teardown(root, environment)
    elif args.command == "scenario":
        require(args.name, "Scenario requires --name")
        scenario = Scenario(root, environment)
        for name in PHASE7 if args.name == "all" else (args.name,):
            scenario.run(name)
    elif args.command == "storage-probe":
        storage_probe(root, environment)
    else:
        require(args.role, "Run-role requires --role")
        run_role(root, environment, args.role)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, urllib.error.URLError) as error:
        print(f"Upload finalization fixture refused/failed: {error}", file=sys.stderr)
        sys.exit(1)
