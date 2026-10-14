#!/usr/bin/env python3
"""Create and retire only resources carrying this test run's ownership identity."""

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MINIO_IMAGE = "quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z"
STATE_FILE = "resolved-environment.json"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def private_write(path, text):
    require(not path.is_symlink(), "Refusing a symlinked private file")
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".new", dir=path.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(text)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def save(root, environment):
    private_write(root / STATE_FILE, json.dumps(environment, indent=2) + "\n")


def private_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077,
            "Test files must be private, regular, and owned by the current user")


def load(root, profile="device-file-preview"):
    require(profile in ("device-file-preview", "device-audio"), "Unknown test profile")
    namespace = profile.replace("-", "_")
    root = Path(root).absolute()
    info = root.lstat()
    require(root == root.resolve() and root.name.startswith(f"echo-{profile}-") and
            root.parent == Path(tempfile.gettempdir()).resolve() and stat.S_ISDIR(info.st_mode) and
            info.st_uid == os.getuid() and not info.st_mode & 0o077,
            "Refusing a foreign, symlinked, or non-private test root")
    private_file(root / STATE_FILE)
    environment = json.loads((root / STATE_FILE).read_text())
    run = environment["run"]
    require(environment.get("profile", "device-file-preview") == profile, "Test profile ownership mismatch")
    require(re.fullmatch(r"[a-f0-9]{20}", run) and environment["root"] == str(root) and
            environment["repository"] == str(REPO), "Test root ownership mismatch")
    require(environment["main_db"] == f"wd_test_{namespace}_{run}" and
            environment["files_db"] == f"wd_files_test_{namespace}_{run}" and
            environment["bucket"] == f"{profile}-{run}", "Unsafe test resource namespace")
    ports = [environment[f"{role}_port"] for role in ("api_a", "api_b", "proxy", "front", "redis", "s3")]
    require(len(set(ports)) == len(ports) and all(isinstance(port, int) and 1024 < port < 65536 for port in ports),
            "Invalid dedicated loopback ports")
    for role in ("a", "b"):
        path = root / f"config-{role}.toml"
        private_file(path)
        require(hashlib.sha256(path.read_bytes()).hexdigest() == environment["config_hashes"][role],
                "Test configuration changed after ownership was established")
        config = tomllib.loads(path.read_text())
        require(config["pg_dbname"] == environment["main_db"] and
                config["file_registry"]["pg_dbname"] == environment["files_db"] and
                config["pg_host"] == "127.0.0.1" and config["file_registry"]["pg_host"] == "127.0.0.1" and
                config["s3_config"]["s3_bucket"] == environment["bucket"] and
                config["s3_config"]["s3_endpoint"] == f"http://127.0.0.1:{environment['s3_port']}" and
                config["storage_dir"] == str(root / f"storage-{role}") and
                config["redis_host"] == "127.0.0.1" and config["redis_port"] == environment["redis_port"],
                "Dedicated config/database/storage mismatch")
    private_file(root / "environment.sh")
    return root, environment


def command(args, root=None, env=None, input=None, cwd=REPO):
    result = subprocess.run(args, cwd=cwd, env=env, input=input, text=True, capture_output=True)
    if root:
        with (root / "setup.log").open("a") as log:
            log.write(result.stdout + result.stderr)
    require(result.returncode == 0, f"{Path(args[0]).name} failed; inspect the private setup log")
    return result.stdout.strip()


def postgres_env(root, environment, database="postgres"):
    config = tomllib.loads((root / "config-a.toml").read_text())
    return {**os.environ, "PGHOST": "127.0.0.1", "PGPORT": str(config["pg_port"]),
            "PGUSER": config["pg_user"], "PGPASSWORD": config["pg_password"], "PGDATABASE": database}


def sql(root, environment, statement, database="postgres"):
    return command(["psql", "-q", "-X", "-At", "-v", "ON_ERROR_STOP=1"], root,
                   postgres_env(root, environment, database), statement)


def docker_host():
    require(not os.environ.get("DOCKER_HOST"), "Refusing DOCKER_HOST override; select a local Docker context")
    endpoint = json.loads(command(["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"] ))
    require(endpoint.startswith("unix:///"), "Dedicated storage requires a local Docker daemon")
    command(["docker", "info", "--format", "{{.ServerVersion}}"])
    command(["docker", "image", "inspect", MINIO_IMAGE, "--format", "{{.Id}}"])


def fresh_ports():
    sockets = []
    try:
        for _ in range(6):
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            sockets.append(listener)
        return [listener.getsockname()[1] for listener in sockets]
    finally:
        for listener in sockets:
            listener.close()


def toml_text(config):
    lines = []
    for key, value in config.items():
        if not isinstance(value, dict):
            lines.append(f"{key} = {json.dumps(value)}")
    for key, section in config.items():
        if isinstance(section, dict):
            lines.append(f"\n[{key}]")
            for field, value in section.items():
                lines.append(f"{field} = {json.dumps(value)}")
    return "\n".join(lines) + "\n"


def prepare(profile="device-file-preview"):
    require(profile in ("device-file-preview", "device-audio"), "Unknown test profile")
    namespace = profile.replace("-", "_")
    for dependency in ("just", "cargo", "psql", "pg_restore", "createdb", "dropdb", "node", "redis-server", "docker", "lsof"):
        require(shutil.which(dependency), f"Missing test prerequisite: {dependency}")
    require((REPO / "deploy/wd_test-2025-08-17-07-43.pgrestore").is_file(), "Standard test dump is missing")
    docker_host()
    root = Path(tempfile.mkdtemp(prefix=f"echo-{profile}-")).resolve()
    os.chmod(root, 0o700)
    run = secrets.token_hex(10)
    ports = fresh_ports()
    environment = {"root": str(root), "repository": str(REPO), "run": run, "stage": "prepared", "profile": profile,
                   "main_db": f"wd_test_{namespace}_{run}", "files_db": f"wd_files_test_{namespace}_{run}",
                   "bucket": f"{profile}-{run}", "container_name": f"{profile}-{run}",
                   "container_id": None, "database_claimed": False, "processes": {}, "config_hashes": {}}
    environment.update({f"{role}_port": port for role, port in zip(("api_a", "api_b", "proxy", "front", "redis", "s3"), ports)})
    config = tomllib.loads((REPO / "deploy/config-test.toml").read_text())
    config.update({"pg_host": "127.0.0.1", "pg_port": int(os.environ.get("PG_PORT", "5432")),
                   "pg_user": os.environ.get("PG_USER", config["pg_user"]),
                   "pg_password": os.environ.get("PG_PASSWORD", config["pg_password"]),
                   "pg_dbname": environment["main_db"], "public_host": f"127.0.0.1:{environment['proxy_port']}",
                   "cookie_session_secret": secrets.token_hex(32), "totp_strongbox_key": base64.b64encode(secrets.token_bytes(32)).decode(),
                   "redis_host": "127.0.0.1", "redis_port": environment["redis_port"],
                   "disable_cleanup_networks_worker": True, "disable_unit_location_v2_worker": True,
                   "disable_suggest_message_tags_worker": True, "disable_inactive_users_worker": True,
                   "skip_discord_notifications": True, "server_id": 1,
                   "static_path": str(REPO / "wdintel-web/public"), "executable_path": str(REPO / "target/debug/wdintel-rs")})
    config["file_registry"] = {key: config[key] for key in ("pg_host", "pg_port", "pg_user", "pg_password")}
    config["file_registry"]["pg_dbname"] = environment["files_db"]
    config["s3_config"] = {"s3_access_key_id": f"preview{run}", "s3_secret_access_key": secrets.token_urlsafe(32),
                           "s3_endpoint": f"http://127.0.0.1:{environment['s3_port']}", "s3_region": "us-east-1",
                           "s3_bucket": environment["bucket"], "strongbox_key": base64.b64encode(secrets.token_bytes(32)).decode()}
    for role in ("a", "b"):
        for directory in (f"storage-{role}", f"cache-{role}"):
            (root / directory).mkdir(mode=0o700)
        config["storage_dir"] = str(root / f"storage-{role}")
        text = toml_text(config)
        private_write(root / f"config-{role}.toml", text)
        environment["config_hashes"][role] = hashlib.sha256(text.encode()).hexdigest()
    values = {"DEVICE_FILE_PREVIEW_ROOT": str(root), "DEVICE_FILE_PREVIEW_RUN": run,
              "PLAYWRIGHT_BASE_URL": f"http://127.0.0.1:{environment['proxy_port']}",
              "ECHO_BASE_URL": f"http://127.0.0.1:{environment['proxy_port']}", "ECHO_CONFIG_PATH": str(root / "config-a.toml"),
              "DEVICE_FILE_PREVIEW_CONFIG_B": str(root / "config-b.toml"), "TEST_DB_NAME": environment["main_db"],
              "TEST_WDFILE_DB_NAME": environment["files_db"], "DB_NAME": environment["main_db"],
              "DEVICE_FILE_PREVIEW_S3_BUCKET": environment["bucket"], "DEVICE_FILE_PREVIEW_S3_ENDPOINT": config["s3_config"]["s3_endpoint"],
              "DEVICE_FILE_PREVIEW_CACHE_A": str(root / "cache-a"), "DEVICE_FILE_PREVIEW_CACHE_B": str(root / "cache-b"),
              "PORT": str(environment["front_port"]), "HOST": "127.0.0.1"}
    private_write(root / "environment.sh", "\n".join(f"export {key}={shlex.quote(value)}" for key, value in values.items()) + "\n")
    private_write(root / "route.json", json.dumps({"api": "a", "media_preflight": "a", "media_stream": "a"}))
    private_write(root / "setup.log", "")
    private_write(root / "fixtures-private.json", json.dumps({"run": run, "actors": {}, "seeded": []}))
    save(root, environment)
    load(root, profile)
    print(root)
    return root, environment


def process_identity(pid):
    state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], text=True, capture_output=True).stdout.strip()
    if not state or state.startswith("Z"):
        return ""
    return subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], text=True, capture_output=True).stdout.strip()


def observe(args):
    result = subprocess.run(args, text=True, capture_output=True)
    return result.stdout.strip() if result.returncode == 0 else ""


def owned_process(record, root, environment):
    actual = process_identity(record["pid"])
    groups = subprocess.run(["ps", "-A", "-o", "pid=,pgid=,stat="], text=True, capture_output=True, check=True).stdout
    members = [int(fields[0]) for line in groups.splitlines() if len(fields := line.split()) == 3 and
               int(fields[1]) == record["pid"] and not fields[2].startswith("Z")]
    if not members:
        return False
    if actual:
        try:
            require(actual == record["started"] and os.getpgid(record["pid"]) == record["pid"],
                    "Refusing to signal a reused PID or foreign process group")
        except ProcessLookupError:
            actual = ""
    identified = {}
    for pid in members:
        if Path(f"/proc/{pid}/environ").exists():
            try:
                variables = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
            except (FileNotFoundError, ProcessLookupError):
                continue
            markers = [f"DEVICE_FILE_PREVIEW_RUN={environment['run']}".encode(), f"DEVICE_FILE_PREVIEW_ROOT={root}".encode()]
            identified[pid] = all(marker in variables for marker in markers)
        else:
            variables = subprocess.run(["ps", "eww", "-p", str(pid), "-o", "command="], text=True, capture_output=True).stdout
            identified[pid] = f" DEVICE_FILE_PREVIEW_RUN={environment['run']}" in variables and f" DEVICE_FILE_PREVIEW_ROOT={root}" in variables
    role = next((role for role, entry in environment["processes"].items() if entry is record), None)
    known = record.setdefault("members", {})
    leader_verified = bool(actual and (identified.get(record["pid"]) or known.get(str(record["pid"])) == actual))
    # Redis/npm change their process title and can overwrite environment memory.
    if actual and not leader_verified and role == "redis":
        cwd = observe(["lsof", "-a", "-p", str(record["pid"]), "-d", "cwd", "-Fn"])
        listener = observe(["lsof", "-nP", "-a", "-p", str(record["pid"]), "-iTCP", "-sTCP:LISTEN", "-Fn"])
        leader_verified = f"n{root}\n" in cwd + "\n" and f"n127.0.0.1:{environment['redis_port']}\n" in listener + "\n"
    if actual and not leader_verified and role == "front":
        title = observe(["ps", "-p", str(record["pid"]), "-o", "args="])
        leader_verified = title.strip() == "npm exec elm-land server" and any(identified.values())
    live_members = 0
    for pid in members:
        lifetime = process_identity(pid)
        if not lifetime:
            continue
        try:
            require(os.getsid(pid) == record["pid"], "Refusing a member outside the owned isolated session")
        except ProcessLookupError:
            continue
        # A verified live session leader proves the origin of its group members.
        # After its exit, retain only previously observed PID lifetimes or markers.
        require(leader_verified or identified.get(pid, False) or known.get(str(pid)) == lifetime,
                "Refusing a process group with a foreign or unobserved member")
        known[str(pid)] = lifetime
        live_members += 1
    return live_members > 0


def signal_group(record, sig):
    try:
        os.killpg(record["pid"], sig)
    except ProcessLookupError:
        pass


def spawn(root, environment, role):
    script = "device_audio_harness.py" if environment.get("profile") == "device-audio" else "file_preview_harness.py"
    with (root / f"{role}.log").open("a") as log:
        os.chmod(root / f"{role}.log", 0o600)
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name(script)), "run-role", "--root", str(root), "--role", role],
                                   cwd=REPO, stdout=log, stderr=log, start_new_session=True, env=runtime_env(root, environment))
    started = process_identity(process.pid)
    require(started, f"Owned {role} launcher exited")
    environment["processes"][role] = {"pid": process.pid, "started": started}
    save(root, environment)


def wait_url(url, timeout=60):
    deadline = time.monotonic() + timeout
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        try:
            with opener.open(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.25)
    raise RuntimeError("Owned test service did not become ready; inspect its private log")


def s3_request(root, environment, method, key, body=b""):
    config = tomllib.loads((root / "config-a.toml").read_text())["s3_config"]
    host = f"127.0.0.1:{environment['s3_port']}"
    now = datetime.now(timezone.utc)
    stamp, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    digest = hashlib.sha256(body).hexdigest()
    path = f"/{environment['bucket']}/{key}"
    headers = f"host:{host}\nx-amz-content-sha256:{digest}\nx-amz-date:{stamp}\n"
    signed = "host;x-amz-content-sha256;x-amz-date"
    canonical = f"{method}\n{path}\n\n{headers}\n{signed}\n{digest}"
    scope = f"{day}/us-east-1/s3/aws4_request"
    signing_key = ("AWS4" + config["s3_secret_access_key"]).encode()
    for part in (day, "us-east-1", "s3", "aws4_request"):
        signing_key = hmac.new(signing_key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(signing_key, f"AWS4-HMAC-SHA256\n{stamp}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}".encode(), hashlib.sha256).hexdigest()
    request = urllib.request.Request(f"http://{host}{path}", data=body if method == "PUT" else None, method=method,
        headers={"x-amz-content-sha256": digest, "x-amz-date": stamp,
                 "Authorization": f"AWS4-HMAC-SHA256 Credential={config['s3_access_key_id']}/{scope}, SignedHeaders={signed}, Signature={signature}"})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
        return response.read()


def start_storage(root, environment):
    docker_host()
    require(environment["container_id"] is None, "Owned storage already exists")
    config = tomllib.loads((root / "config-a.toml").read_text())["s3_config"]
    private_write(root / "minio.env", f"MINIO_ROOT_USER={config['s3_access_key_id']}\nMINIO_ROOT_PASSWORD={config['s3_secret_access_key']}\n")
    identifier = command(["docker", "run", "--detach", "--pull=never", "--name", environment["container_name"],
                          "--label", f"echo.{environment.get('profile', 'device-file-preview')}.run={environment['run']}",
                          "--label", f"echo.{environment.get('profile', 'device-file-preview')}.repository={REPO}",
                          "--publish", f"127.0.0.1:{environment['s3_port']}:9000", "--env-file", str(root / "minio.env"),
                          MINIO_IMAGE, "server", "/data"], root)
    environment["container_id"] = identifier
    save(root, environment)
    wait_url(f"http://127.0.0.1:{environment['s3_port']}/minio/health/ready")
    s3_request(root, environment, "PUT", "")
    probe = secrets.token_bytes(97)
    s3_request(root, environment, "PUT", "harness-ownership-probe", probe)
    require(s3_request(root, environment, "GET", "harness-ownership-probe") == probe, "Actual signed S3 byte roundtrip failed")
    s3_request(root, environment, "DELETE", "harness-ownership-probe")
    environment["storage_verified"] = True
    save(root, environment)


def restore_databases(root, environment):
    for name in (environment["main_db"], environment["files_db"]):
        require(not sql(root, environment, f"SELECT 1 FROM pg_database WHERE datname='{name}';"), "Refusing existing database")
    config = tomllib.loads((root / "config-a.toml").read_text())
    env = {**os.environ, "PG_HOST": "127.0.0.1", "PG_PORT": str(config["pg_port"]),
           "PG_USER": config["pg_user"], "PG_PASSWORD": config["pg_password"], "POSTGRES_STARTUP_TIMEOUT_SECS": "10"}
    environment["database_claimed"] = True
    save(root, environment)
    try:
        command(["bash", str(REPO / "deploy/setup_test_database.sh"), f"{environment.get('profile', 'device-file-preview').replace('-', '_')}_{environment['run']}"], root, env)
    finally:
        for name in (environment["main_db"], environment["files_db"]):
            if sql(root, environment, f"SELECT 1 FROM pg_database WHERE datname='{name}';"):
                sql(root, environment, f"COMMENT ON DATABASE {name} IS 'echo-{environment.get('profile', 'device-file-preview')}:{environment['run']}';")


def runtime_env(root, environment, role="a"):
    return {**os.environ, "ECHO_CONFIG_PATH": str(root / f"config-{role}.toml"), "TEST_DB_NAME": environment["main_db"],
            "TEST_WDFILE_DB_NAME": environment["files_db"], "DEVICE_FILE_PREVIEW_ROOT": str(root),
            "DEVICE_FILE_PREVIEW_RUN": environment["run"], "RUST_BACKTRACE": "0", "RUST_LOG": "warn",
            "DEVICE_FILE_PREVIEW_CACHE_DIR": str(root / f"cache-{role}"),
            "DEVICE_FILE_PREVIEW_CONFIG_B": str(root / "config-b.toml"),
            "DEVICE_FILE_PREVIEW_S3_BUCKET": environment["bucket"],
            "DEVICE_FILE_PREVIEW_S3_ENDPOINT": f"http://127.0.0.1:{environment['s3_port']}",
            "PLAYWRIGHT_BASE_URL": f"http://127.0.0.1:{environment['proxy_port']}",
            "ECHO_BASE_URL": f"http://127.0.0.1:{environment['proxy_port']}"}


def bootstrap_actor(root, environment):
    fixtures = json.loads((root / "fixtures-private.json").read_text())
    if fixtures["actors"].get("admin"):
        return
    organism = sql(root, environment, f"INSERT INTO organism(name,roles,enabled) VALUES('preview-bootstrap-{environment['run']}','[\"Admin\",\"Api\"]'::jsonb,true) RETURNING id;", environment["main_db"])
    zone = sql(root, environment, f"INSERT INTO sigint_zone(name) VALUES('preview-bootstrap-{environment['run']}') RETURNING id;", environment["main_db"])
    require(organism.isdigit() and zone.isdigit(), "Could not create owned bootstrap organism/zone")
    login, password = f"preview-bootstrap-{environment['run']}", secrets.token_urlsafe(24)
    command([str(REPO / "target/debug/wdintel-rs"), "--mode=test", "oneoff-register-user", "--login", login,
             "--password", password, "--role", "Admin", "--sigint-zone", zone, "--organism-id", organism],
            root, runtime_env(root, environment))
    # Only the initial fixture administrator is bootstrapped. Other identities
    # and every device/file/content operation go through the authenticated API.
    sql(root, environment, f"UPDATE login SET roles='[\"Admin\",\"Api\"]'::jsonb WHERE login='{login}';", environment["main_db"])
    private_write(root / "fixtures-private.json", json.dumps({"run": environment["run"],
        "bootstrap": {"organismId": int(organism), "sigintZoneId": int(zone)},
        "actors": {"admin": {"login": login, "password": password, "roles": ["Admin", "Api"]}}, "seeded": []}, indent=2))


def setup(root, environment, storage_only=False, resume=False):
    require(environment["stage"] in ("prepared", "storage-ready") or resume and environment["stage"] in ("restoring", "migrating", "building"),
            "Setup accepts a fresh prepared run or explicitly resumed incomplete run only")
    require(not environment["processes"], "Refusing to replace existing owned processes; teardown first")
    if environment["container_id"] is None:
        start_storage(root, environment)
    if storage_only:
        environment["stage"] = "storage-ready"
        save(root, environment)
        return
    if environment["database_claimed"]:
        require(resume, "Use --resume for this existing owned migration environment")
        for name in (environment["main_db"], environment["files_db"]):
            require(sql(root, environment, f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{name}';") ==
                    f"echo-{environment.get('profile', 'device-file-preview')}:{environment['run']}", "Cannot resume a foreign or missing database")
    else:
        environment["stage"] = "restoring"
        save(root, environment)
        restore_databases(root, environment)
    environment["stage"] = "migrating"
    save(root, environment)
    command(["just", "migrate-all-up", "test"], root, runtime_env(root, environment))
    environment["stage"] = "building"
    save(root, environment)
    command(["cargo", "build", "-p", "wdintel-rs"], root, runtime_env(root, environment))
    bootstrap_actor(root, environment)
    spawn(root, environment, "redis")
    for role in ("a", "b"):
        spawn(root, environment, f"api-{role}")
        wait_url(f"http://127.0.0.1:{environment[f'api_{role}_port']}/api/ping", 120)
    spawn(root, environment, "bgworker")
    spawn(root, environment, "front")
    wait_url(f"http://127.0.0.1:{environment['front_port']}", 120)
    spawn(root, environment, "proxy")
    wait_url(f"http://127.0.0.1:{environment['proxy_port']}/api/ping")
    environment["stage"] = "ready"
    save(root, environment)


def run_role(root, environment, role):
    env = runtime_env(root, environment, "b" if role == "api-b" else "a")
    if role in ("api-a", "api-b", "bgworker"):
        cache = str(root / ("cache-b" if role == "api-b" else "cache-a"))
        env.update({"TMPDIR": cache, "TMP": cache, "TEMP": cache})
    binary = str(REPO / "target/debug/wdintel-rs")
    if role in ("api-a", "api-b"):
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", environment[f"api_{role[-1]}_port"]))
        listener.listen(128)
        os.dup2(listener.fileno(), 3)
        os.set_inheritable(3, True)
        env.update({"LISTEN_PID": str(os.getpid()), "LISTEN_FDS": "1", "ECHO_DEV_BACK_REST_ONLY": "true"})
        os.execve(binary, [binary, "--mode=debug", "server", "--no-bgworker"], env)
    elif role == "bgworker":
        os.execve(binary, [binary, "--mode=debug", "bgworker"], env)
    elif role == "redis":
        os.execve(shutil.which("redis-server"), ["redis-server", "--bind", "127.0.0.1", "--port", str(environment["redis_port"]),
                  "--save", "", "--appendonly", "no", "--dir", str(root)], env)
    elif role == "front":
        os.chdir(REPO / "wdintel-web")
        env.update({"HOST": "127.0.0.1", "PORT": str(environment["front_port"])})
        os.execvpe("npx", ["npx", "--no-install", "elm-land", "server"], env)
    elif role == "proxy":
        os.execve(sys.executable, [sys.executable, str(Path(__file__).with_name("file_preview_proxy.py")), str(root)], env)


def teardown(root, environment):
    for record in environment["processes"].values():
        owned_process(record, root, environment)
    save(root, environment)
    for record in reversed(list(environment["processes"].values())):
        if owned_process(record, root, environment):
            signal_group(record, signal.SIGTERM)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and any(owned_process(record, root, environment) for record in environment["processes"].values()):
        time.sleep(0.1)
    for record in environment["processes"].values():
        if owned_process(record, root, environment):
            signal_group(record, signal.SIGKILL)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and any(owned_process(record, root, environment) for record in environment["processes"].values()):
        time.sleep(0.1)
    require(not any(owned_process(record, root, environment) for record in environment["processes"].values()),
            "Owned process group did not drain; ownership records retained")
    if environment["container_id"]:
        docker_host()
        details = json.loads(command(["docker", "inspect", environment["container_id"]]))[0]
        labels = details["Config"]["Labels"]
        require(details["Name"] == "/" + environment["container_name"] and
                labels.get(f"echo.{environment.get('profile', 'device-file-preview')}.run") == environment["run"] and
                labels.get(f"echo.{environment.get('profile', 'device-file-preview')}.repository") == str(REPO), "Refusing a foreign Docker container")
        command(["docker", "rm", "--force", "--volumes", environment["container_id"]], root)
        environment["container_id"] = None
        save(root, environment)
    if environment["database_claimed"]:
        for name in (environment["main_db"], environment["files_db"]):
            exists = sql(root, environment, f"SELECT 1 FROM pg_database WHERE datname='{name}';")
            if exists:
                marker = sql(root, environment, f"SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='{name}';")
                require(marker == f"echo-{environment.get('profile', 'device-file-preview')}:{environment['run']}", "Refusing to drop a database without the ownership marker")
                command(["dropdb", name], root, postgres_env(root, environment))
        environment["database_claimed"] = False
    environment["processes"] = {}
    environment["stage"] = "retired"
    save(root, environment)
    print("Owned processes, databases and test container retired; private logs retained at", root)


def main():
    parser = argparse.ArgumentParser(description="Dedicated device file preview test environment; never touches ordinary dev services")
    parser.add_argument("command", choices=("prepare", "setup", "status", "route", "seed", "teardown", "run-role", "check-ownership", "faults"))
    parser.add_argument("--root", help="Owned root printed by prepare/setup")
    parser.add_argument("--storage-only", action="store_true", help="Verify real local S3 ownership without starting Echo")
    parser.add_argument("--resume", action="store_true", help="Resume only this run's marked databases after a failed build/start")
    parser.add_argument("--api", choices=("a", "b"), default="a")
    parser.add_argument("--media-preflight", choices=("a", "b"), default="a")
    parser.add_argument("--media-stream", choices=("a", "b"), default="a")
    parser.add_argument("--role", choices=("api-a", "api-b", "bgworker", "front", "proxy", "redis"))
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "check-ownership":
        os.execve(sys.executable, [sys.executable, str(Path(__file__).with_name("test_file_preview_ownership.py")), "--database"], os.environ)
    if args.command == "prepare" or (args.command == "setup" and not args.root):
        root, environment = prepare()
        if args.command == "prepare":
            return
    else:
        require(args.root, "Supply --root from this run; no default shared environment is accepted")
        root, environment = load(args.root)
    if args.command == "setup":
        setup(root, environment, args.storage_only, args.resume)
        print("Owned test stage:", environment["stage"], "| source", root / "environment.sh")
    elif args.command == "status":
        processes = {role: owned_process(record, root, environment) for role, record in environment["processes"].items()}
        for role in ("api-a", "api-b", "bgworker", "front", "proxy", "redis"):
            processes.setdefault(role, False)
        save(root, environment)
        print(json.dumps({"run": environment["run"], "stage": environment["stage"],
                          "origin": f"http://127.0.0.1:{environment['proxy_port']}",
                          "processes": processes,
                          "storage_verified": environment.get("storage_verified", False)}, indent=2))
    elif args.command == "route":
        private_write(root / "route.json", json.dumps({"api": args.api, "media_preflight": args.media_preflight, "media_stream": args.media_stream}))
        print("Same-origin routing updated for owned APIs")
    elif args.command == "seed":
        require(environment["stage"] == "ready", "Seed requires both actual Echo APIs, worker and frontend ready")
        env = {**runtime_env(root, environment), "PLAYWRIGHT_BASE_URL": f"http://127.0.0.1:{environment['proxy_port']}",
               "ECHO_BASE_URL": f"http://127.0.0.1:{environment['proxy_port']}"}
        modules = root / "node_modules"
        if modules.exists():
            require(modules.is_symlink() and modules.resolve() == (REPO / "wdintel-web/node_modules").resolve(), "Foreign seed dependency directory")
        else:
            modules.symlink_to(REPO / "wdintel-web/node_modules", target_is_directory=True)
        source = REPO / "wdintel-web/tests/e2e/device-file-preview-backend.ts"
        command([str(REPO / "wdintel-web/node_modules/.bin/esbuild"), str(source), "--bundle", "--platform=node",
                 "--packages=external", "--format=esm", f"--define:import.meta.url={json.dumps(source.as_uri())}",
                 f"--outfile={root / 'seed.mjs'}"], root, env)
        command(["node", str(root / "seed.mjs"), "--seed"], root, env)
        print("Real FileSync/TUS fixtures seeded; private receipt:", root / "fixtures-private.json")
    elif args.command == "teardown":
        teardown(root, environment)
    elif args.command == "run-role":
        require(args.role, "Missing owned process role")
        run_role(root, environment, args.role)
    elif args.command == "faults":
        os.execve(sys.executable, [sys.executable, str(Path(__file__).with_name("file_preview_faults.py")), "--root", str(root)], runtime_env(root, environment))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, urllib.error.URLError) as error:
        print(f"Device preview harness refused/failed: {error}", file=sys.stderr)
        sys.exit(1)
