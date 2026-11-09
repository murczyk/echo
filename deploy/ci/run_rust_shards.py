#!/usr/bin/env python3
"""Run the Rust test binary as parallel shards on disposable services.

`#[serial]` tests only exclude each other inside one process, so each shard gets
its own databases, Redis and storage. PostgreSQL runs from RAM with durability
off, which is safe because every run restores the dump and deletes the cluster.

Run this with the storage venv's Python, which provides `toml`.
"""

import hashlib
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "ci"))
from profile_rust_tests import build_test_executable  # noqa: E402

SHARD_COUNT = int(os.environ.get("ECHO_CI_RUST_SHARDS", "8"))
TEST_THREADS_PER_SHARD = int(os.environ.get("ECHO_CI_RUST_SHARD_THREADS", "4"))
SHARD_SALT = os.environ.get("ECHO_CI_RUST_SHARD_SALT", "")
SHARD_TIMEOUT_SECS = int(os.environ.get("ECHO_CI_RUST_SHARD_TIMEOUT_SECS", "1800"))
HEARTBEAT_SECS = 30
SERVICE_START_TIMEOUT_SECS = 30
SHARD_STOP_TIMEOUT_SECS = 20
FAILURE_EXCERPT_MAX_LINES = 2000
FAILURE_TAIL_LINES = 200

POSTGRES_BIN = Path(os.environ.get("ECHO_CI_POSTGRES_BIN", "/usr/lib/postgresql/18/bin"))
SERVICE_HOST = "127.0.0.1"
# Both sit below the kernel's ephemeral port range, so test sockets cannot take them.
POSTGRES_PORT = 29432
REDIS_BASE_PORT = 29500
POSTGRES_SETTINGS = {
    "listen_addresses": SERVICE_HOST,
    "ssl": "off",
    "fsync": "off",
    "synchronous_commit": "off",
    "full_page_writes": "off",
    "max_connections": "1000",
    "shared_buffers": "4GB",
    "max_wal_size": "8GB",
    "checkpoint_timeout": "30min",
    "dynamic_shared_memory_type": "mmap",
    "TimeZone": "Etc/UTC",
}
BASE_DATABASE_SUFFIX = "ci"
MAIN_DATABASE = f"wd_test_{BASE_DATABASE_SUFFIX}"
FILE_DATABASE = f"wd_files_test_{BASE_DATABASE_SUFFIX}"
MIGRATION_TEST = "functest::tests::ci_migrate_test_databases"

STORAGE_WRAPPER = REPO_ROOT / "deploy" / "ci" / "with_test_storage.sh"
TEST_RESULT = re.compile(
    r"^test result: \S+\. (?P<passed>\d+) passed; (?P<failed>\d+) failed; (?P<ignored>\d+) ignored;",
    re.MULTILINE,
)


@dataclass
class Shard:
    index: int
    tests: list[str]
    log: Path
    process: subprocess.Popen | None = None
    timed_out: bool = False

    @property
    def main_database(self) -> str:
        return f"{MAIN_DATABASE}_s{self.index}"

    @property
    def file_database(self) -> str:
        return f"{FILE_DATABASE}_s{self.index}"


class Services:
    """Background processes that must stop however the run ends."""

    def __init__(self, log_directory: Path) -> None:
        self.log_directory = log_directory
        self.processes: list[subprocess.Popen] = []

    def start(self, name: str, command: list[str]) -> subprocess.Popen:
        with open(self.log_directory / f"{name}.log", "wb") as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        self.processes.append(process)
        return process

    def stop(self) -> None:
        for process in reversed(self.processes):
            stop_process(process)


def stop_process(process: subprocess.Popen) -> None:
    if process.poll() is None:
        process.terminate()
        wait_or_kill(process)


def wait_or_kill(process: subprocess.Popen) -> None:
    try:
        process.wait(SHARD_STOP_TIMEOUT_SECS)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def stop_shards(shards: list[Shard]) -> None:
    processes = [shard.process for shard in shards if shard.process is not None]
    # Signal all of them first, so one slow shard does not delay the others.
    # Signal once: a second SIGTERM kills the storage wrapper during its cleanup.
    for process in processes:
        if process.poll() is None:
            process.terminate()
    for process in processes:
        wait_or_kill(process)


def assign_shards(names: list[str], count: int, salt: str = "") -> list[list[str]]:
    """Split tests by a stable hash, so a test keeps its shard between runs."""
    shards: list[list[str]] = [[] for _ in range(count)]
    for name in names:
        digest = hashlib.sha256(f"{salt}{name}".encode()).digest()
        shards[int.from_bytes(digest[:8], "big") % count].append(name)
    return shards


def parse_test_names(listing: str) -> list[str]:
    suffix = ": test"
    return [
        line.removesuffix(suffix)
        for line in listing.splitlines()
        if line.endswith(suffix) and " " not in line.removesuffix(suffix)
    ]


def parse_result(log_text: str) -> dict[str, int] | None:
    """Return the harness totals, or None when the shard never finished.

    Tests that re-execute this binary print their own result lines earlier, so
    only the last line describes the shard.
    """
    results = list(TEST_RESULT.finditer(log_text))
    if not results:
        return None
    return {key: int(value) for key, value in results[-1].groupdict().items()}


def failure_excerpt(log_text: str) -> str:
    """Return the harness failure report, or the log tail after a crash."""
    lines = log_text.splitlines()
    if "failures:" in lines:
        lines = lines[lines.index("failures:") :]
        return "\n".join(lines[-FAILURE_EXCERPT_MAX_LINES:])
    return "\n".join(lines[-FAILURE_TAIL_LINES:])


def shard_problem(shard: Shard, log_text: str) -> str | None:
    """Describe why a shard cannot be trusted, or None when it fully passed."""
    if shard.timed_out:
        return f"timed out after {SHARD_TIMEOUT_SECS}s"
    result = parse_result(log_text)
    if result is None:
        return "stopped without a test result"
    if result["failed"] > 0:
        return f"{result['failed']} tests failed"
    finished = result["passed"] + result["ignored"]
    if finished != len(shard.tests):
        return f"finished {finished} of {len(shard.tests)} assigned tests"
    if shard.process is None or shard.process.returncode != 0:
        return "exited with an error"
    return None


def write_source_config(path: Path, redis_port: int | None = None) -> None:
    import toml

    source = Path(os.environ.get("ECHO_CONFIG_PATH", REPO_ROOT / "deploy/config-test.toml"))
    config = toml.load(source)
    for section in (config, config["file_registry"]):
        section["pg_host"] = SERVICE_HOST
        section["pg_port"] = POSTGRES_PORT
    if redis_port is not None:
        config["redis_host"] = SERVICE_HOST
        config["redis_port"] = redis_port
    path.write_text(toml.dumps(config))


def require_free_port(port: int, name: str) -> None:
    """Fail instead of letting tests share a service left over from another run."""
    with socket.socket() as probe:
        if probe.connect_ex((SERVICE_HOST, port)) == 0:
            raise RuntimeError(f"{name} port {port} is already in use")


def wait_for_port(port: int, process: subprocess.Popen, name: str) -> None:
    deadline = time.monotonic() + SERVICE_START_TIMEOUT_SECS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"{name} exited during startup")
        try:
            socket.create_connection((SERVICE_HOST, port), timeout=1).close()
            return
        except OSError:
            time.sleep(0.05)
    raise RuntimeError(f"{name} did not start within {SERVICE_START_TIMEOUT_SECS}s")


def start_postgres(services: Services, root: Path) -> None:
    require_free_port(POSTGRES_PORT, "PostgreSQL")
    data_directory = root / "postgres"
    subprocess.run(
        [
            str(POSTGRES_BIN / "initdb"),
            f"--pgdata={data_directory}",
            "--username=wd",
            "--auth=trust",
            "--encoding=UTF8",
            "--locale=en_US.UTF-8",
            "--no-data-checksums",
            "--no-sync",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    command = [
        str(POSTGRES_BIN / "postgres"),
        "-D",
        str(data_directory),
        "-p",
        str(POSTGRES_PORT),
        "-k",
        str(root),
    ]
    for name, value in POSTGRES_SETTINGS.items():
        command += ["-c", f"{name}={value}"]
    wait_for_port(POSTGRES_PORT, services.start("postgres", command), "PostgreSQL")


def start_redis(services: Services, shard: Shard, root: Path) -> None:
    directory = root / f"redis-{shard.index}"
    directory.mkdir()
    port = REDIS_BASE_PORT + shard.index
    require_free_port(port, f"Redis for shard {shard.index}")
    process = services.start(
        f"redis-{shard.index}",
        [
            "redis-server",
            "--port",
            str(port),
            "--bind",
            SERVICE_HOST,
            "--save",
            "",
            "--appendonly",
            "no",
            "--dir",
            str(directory),
        ],
    )
    wait_for_port(port, process, f"Redis for shard {shard.index}")


def database_environment(source_config: Path, scratch: Path) -> dict[str, str]:
    return {
        **os.environ,
        "TMPDIR": str(scratch),
        "PG_HOST": SERVICE_HOST,
        "PG_PORT": str(POSTGRES_PORT),
        "TEST_DB_NAME": MAIN_DATABASE,
        "TEST_WDFILE_DB_NAME": FILE_DATABASE,
        "ECHO_CONFIG_PATH": str(source_config),
    }


def prepare_databases(binary: Path, test_directory: Path, environment: dict[str, str]) -> None:
    subprocess.run(
        ["bash", str(REPO_ROOT / "deploy/setup_test_database.sh"), BASE_DATABASE_SUFFIX],
        check=True,
        env=environment,
        stdout=subprocess.DEVNULL,
    )
    # This check compares base and proposed schemas, so it needs the unmigrated database.
    subprocess.run(
        ["bash", str(REPO_ROOT / "scripts/ci/check_analytics_migration_catalog.sh")],
        check=True,
        env=environment,
    )
    subprocess.run(
        ["bash", str(STORAGE_WRAPPER), str(binary), MIGRATION_TEST, "--exact", "--ignored"],
        check=True,
        cwd=test_directory,
        env=environment,
        stdout=subprocess.DEVNULL,
    )


def clone_databases(shards: list[Shard], environment: dict[str, str]) -> None:
    connection = ["-h", SERVICE_HOST, "-p", str(POSTGRES_PORT), "-U", "wd"]
    for shard in shards:
        for template, clone in (
            (MAIN_DATABASE, shard.main_database),
            (FILE_DATABASE, shard.file_database),
        ):
            subprocess.run(
                ["createdb", *connection, f"--template={template}", clone],
                check=True,
                env=environment,
            )


def list_tests(binary: Path, test_directory: Path) -> list[str]:
    # The skip is required: without it the test binary's constructor would create
    # and migrate a database on the host's shared cluster just to list names.
    listing = subprocess.run(
        [str(binary), "--list", "--format", "terse"],
        check=True,
        cwd=test_directory,
        env={**os.environ, "WDINTEL_SKIP_TEST_DB_INIT": "1"},
        stdout=subprocess.PIPE,
        text=True,
    ).stdout
    return parse_test_names(listing)


def start_shard(
    shard: Shard,
    binary: Path,
    test_directory: Path,
    root: Path,
    scratch: Path,
) -> None:
    source_config = root / f"shard-{shard.index}.toml"
    write_source_config(source_config, REDIS_BASE_PORT + shard.index)
    temporary_directory = scratch / f"s{shard.index}"
    temporary_directory.mkdir(parents=True)
    with open(shard.log, "wb") as log:
        shard.process = subprocess.Popen(
            [
                "bash",
                str(STORAGE_WRAPPER),
                str(binary),
                f"--test-threads={TEST_THREADS_PER_SHARD}",
                "--exact",
                *shard.tests,
            ],
            cwd=test_directory,
            env={
                **os.environ,
                "TEST_DB_NAME": shard.main_database,
                "TEST_WDFILE_DB_NAME": shard.file_database,
                "ECHO_CONFIG_PATH": str(source_config),
                "TMPDIR": str(temporary_directory),
            },
            stdout=log,
            stderr=subprocess.STDOUT,
        )


def wait_for_shards(shards: list[Shard]) -> None:
    started = time.monotonic()
    next_heartbeat = started + HEARTBEAT_SECS
    while True:
        running = [shard for shard in shards if shard.process.poll() is None]
        if not running:
            return
        now = time.monotonic()
        if now - started > SHARD_TIMEOUT_SECS:
            for shard in running:
                shard.timed_out = True
            stop_shards(running)
            return
        if now >= next_heartbeat:
            finished = len(shards) - len(running)
            print(f"{int(now - started)}s: {finished}/{len(shards)} shards finished", flush=True)
            next_heartbeat += HEARTBEAT_SECS
        time.sleep(0.5)


def report(shards: list[Shard], listed_count: int) -> bool:
    passed = ignored = 0
    healthy = True
    for shard in shards:
        log_text = shard.log.read_text(errors="replace")
        problem = shard_problem(shard, log_text)
        result = parse_result(log_text) or {"passed": 0, "ignored": 0}
        passed += result["passed"]
        ignored += result["ignored"]
        if problem is None:
            continue
        healthy = False
        print(f"\n===== Shard {shard.index} {problem} ({shard.log}) =====")
        print(failure_excerpt(log_text), flush=True)
    print(f"\nRust tests: {passed} passed, {ignored} ignored, {listed_count} listed")
    if healthy and passed + ignored != listed_count:
        print("Shard totals do not match the listed tests; a test did not run.")
        return False
    return healthy


def run_shards(binary: Path, test_directory: Path, root: Path, scratch: Path, logs: Path) -> bool:
    services = Services(logs)
    shards: list[Shard] = []
    try:
        start_postgres(services, root)
        base_config = root / "base.toml"
        write_source_config(base_config)
        environment = database_environment(base_config, scratch)
        prepare_databases(binary, test_directory, environment)

        names = list_tests(binary, test_directory)
        shards = [
            Shard(index, tests, logs / f"shard-{index}.log")
            for index, tests in enumerate(assign_shards(names, SHARD_COUNT, SHARD_SALT))
        ]
        clone_databases(shards, environment)
        for shard in shards:
            start_redis(services, shard, root)

        print(f"Running {len(names)} tests in {SHARD_COUNT} shards...", flush=True)
        started = time.monotonic()
        for shard in shards:
            start_shard(shard, binary, test_directory, root, scratch)
        wait_for_shards(shards)
        print(f"Shards finished in {time.monotonic() - started:.0f}s", flush=True)
        return report(shards, len(names))
    finally:
        # Shards stop first, so no test outlives the services it depends on.
        stop_shards(shards)
        services.stop()


def exit_on_termination(_signal_number: int, _frame: object) -> None:
    # Default SIGTERM handling would skip the cleanup in `finally`.
    sys.exit(128 + signal.SIGTERM)


def main() -> int:
    signal.signal(signal.SIGTERM, exit_on_termination)
    run_name = os.environ.get("ECHO_CI_RUN", f"local-{os.getpid()}")
    root = Path("/dev/shm") / f"echo-ci-{run_name}"
    scratch = Path("/tmp") / f"echo-ci-{run_name}"
    logs = REPO_ROOT / "target" / "ci-shards"
    shutil.rmtree(logs, ignore_errors=True)
    logs.mkdir(parents=True)

    binary, test_directory = build_test_executable()
    try:
        root.mkdir()
        scratch.mkdir()
        return 0 if run_shards(binary, test_directory, root, scratch, logs) else 1
    finally:
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
