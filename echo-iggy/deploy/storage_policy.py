#!/usr/bin/env python3
import argparse
import contextlib
import dataclasses
import fcntl
import heapq
import json
import os
from pathlib import Path
import struct
import sys
import time
import urllib.parse
import urllib.request

try:
    import tomllib
except ModuleNotFoundError:
    import toml as tomllib


MAX_STORAGE_BYTES = 100_000_000_000
RETENTION_DAYS = 30
MAX_DELETIONS = 1_000
INDEX_RECORD = struct.Struct("<IIQ")
TOPIC_SETTINGS = (
    "name", "compression_algorithm", "replication_factor", "max_topic_size",
    "message_expiry",
)


@dataclasses.dataclass(frozen=True)
class Segment:
    path: Path
    partition: tuple
    end_timestamp: int
    end_offset: int
    allocated_bytes: int


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise RuntimeError("Iggy API redirects are unsupported")


class IggyApi:
    def __init__(self, base_url, username, password):
        address = urllib.parse.urlsplit(base_url)
        if (address.scheme != "http" or address.hostname not in {"127.0.0.1", "::1"}
                or not address.port or address.path not in {"", "/"}
                or address.query or address.fragment or address.username is not None):
            raise RuntimeError("The API must be the local Iggy HTTP listener")
        self.base_url = base_url.rstrip("/")
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirects())
        self.token = ""
        identity = self.request("POST", "/users/login", {
            "username": username, "password": password,
        })
        self.token = identity["access_token"]["token"]

    def request(self, method, path, body=None):
        headers = {"Accept": "application/json"}
        data = None
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base_url + path, data=data, headers=headers, method=method,
        )
        with self.http.open(request, timeout=30) as response:
            payload = response.read()
        return json.loads(payload) if payload else None


def verify_runtime(data_path, base_url=None):
    config_path = data_path.parent / "runtime/current_config.toml"
    config = tomllib.loads(config_path.read_text())
    enabled = config["data_maintenance"]["messages"]["cleaner_enabled"]
    if enabled is not False:
        raise RuntimeError("Disable Iggy's native cleaner before using the disk policy")
    if base_url is not None:
        actual = urllib.parse.urlsplit("//" + config["http"]["address"])
        expected = urllib.parse.urlsplit(base_url)
        if (config["http"]["enabled"] is not True or actual.port != expected.port
                or actual.hostname not in {"0.0.0.0", "::", expected.hostname}):
            raise RuntimeError("API listener does not match the local runtime config")


def partition_files(data_path):
    partitions = {}
    allocated = data_path.stat().st_blocks * 512
    for path in data_path.rglob("*"):
        if path.is_symlink():
            raise RuntimeError(f"Unexpected symlink in Iggy storage: {path}")
        allocated += path.stat().st_blocks * 512
        if not path.is_file():
            continue
        if path.stat().st_nlink != 1:
            raise RuntimeError(f"Unexpected hard link in Iggy storage: {path}")
        parts = path.relative_to(data_path).parts
        if len(parts) != 6 or parts[1] != "topics" or parts[3] != "partitions":
            continue
        if not all(parts[index].isdigit() for index in (0, 2, 4)):
            raise RuntimeError(f"Unexpected partition path: {path}")
        if path.suffix not in {".log", ".index"} or not path.stem.isdigit():
            raise RuntimeError(f"Unsupported segment format: {path}")
        key = tuple(int(parts[index]) for index in (0, 2, 4))
        partitions.setdefault(key, set()).add(path.with_suffix(""))
    return allocated, partitions


def read_segment(base, partition):
    log_path = base.with_suffix(".log")
    index_path = base.with_suffix(".index")
    size = index_path.stat().st_size
    if size == 0 or size % INDEX_RECORD.size:
        raise RuntimeError(f"Invalid sealed segment index: {index_path}")
    with index_path.open("rb") as index:
        first = INDEX_RECORD.unpack(index.read(INDEX_RECORD.size))
        index.seek(-INDEX_RECORD.size, os.SEEK_END)
        last = INDEX_RECORD.unpack(index.read(INDEX_RECORD.size))
    if not (0 < first[2] <= last[2] <= (time.time() + 60) * 1_000_000):
        raise RuntimeError(f"Invalid segment timestamps: {index_path}")
    allocated = sum(path.stat().st_blocks * 512 for path in (log_path, index_path))
    return Segment(log_path, partition, last[2], int(base.name) + last[0], allocated)


def storage_snapshot(data_path):
    if not data_path.is_dir() or data_path.is_symlink():
        raise RuntimeError(f"Missing or unsafe Iggy streams directory: {data_path}")
    allocated, partitions = partition_files(data_path)
    sealed = {}
    for key, bases in partitions.items():
        bases = sorted(bases, key=lambda path: int(path.name))
        for base in bases:
            if not base.with_suffix(".log").is_file() or not base.with_suffix(".index").is_file():
                raise RuntimeError(f"Incomplete segment files: {base}")
        sealed[key] = [read_segment(base, key) for base in bases[:-1]]
    return allocated, sealed


def deletion_plan(allocated, partitions, max_bytes, cutoff):
    queue = []
    for key, segments in partitions.items():
        if segments:
            heapq.heappush(queue, (segments[0].end_timestamp, key, 0))
    plan = []
    while queue:
        timestamp, key, index = heapq.heappop(queue)
        if timestamp >= cutoff and allocated <= max_bytes:
            break
        segment = partitions[key][index]
        plan.append(segment)
        allocated -= segment.allocated_bytes
        index += 1
        if index < len(partitions[key]):
            heapq.heappush(queue, (partitions[key][index].end_timestamp, key, index))
    return plan, allocated


def reconcile_topics(api, partitions, expiry, apply):
    known = set()
    topics = []
    for stream in api.request("GET", "/streams"):
        stream_id = stream["id"]
        for topic in api.request("GET", f"/streams/{stream_id}/topics"):
            path = f"/streams/{stream_id}/topics/{topic['id']}"
            topic = api.request("GET", path)
            topics.append((path, topic))
            for partition in topic["partitions"]:
                known.add((stream_id, topic["id"], partition["id"]))
    if known != set(partitions):
        raise RuntimeError("API partitions do not match the local storage; refusing deletion")
    for path, topic in topics:
        settings = {name: topic[name] for name in TOPIC_SETTINGS}
        if settings["message_expiry"] == expiry:
            continue
        emit(action="retention_drift", topic=path, old_expiry=settings["message_expiry"], expiry=expiry)
        if apply:
            settings["message_expiry"] = expiry
            api.request("PUT", path, settings)
            actual = api.request("GET", path)
            if any(actual.get(name) != value for name, value in settings.items()):
                raise RuntimeError(f"Topic policy verification failed: {path}")


def delete_segment(api, segment):
    logs = sorted(segment.path.parent.glob("*.log"), key=lambda path: int(path.stem))
    if len(logs) < 2 or logs[0] != segment.path:
        raise RuntimeError(f"Partition changed before deletion: {segment.path}")
    stream, topic, partition = segment.partition
    path = f"/streams/{stream}/topics/{topic}/partitions/{partition}?segments_count=1"
    api.request("DELETE", path)
    if segment.path.exists() or segment.path.with_suffix(".index").exists():
        raise RuntimeError(
            f"Segment deletion was blocked: {segment.path}; "
            f"consumer offsets={json.dumps(blocking_offsets(segment))}; inspect server logs"
        )
    emit(action="deleted", segment=str(segment.path), allocated_bytes=segment.allocated_bytes)


def blocking_offsets(segment):
    blockers = []
    for kind in ("consumers", "groups"):
        for path in sorted((segment.path.parent / "offsets" / kind).glob("*")):
            offset = struct.unpack("<Q", path.read_bytes())[0]
            if offset < segment.end_offset:
                blockers.append({"kind": kind, "id": path.name, "offset": offset})
    return blockers


def run_policy(api, data_path, max_bytes, retention_days, apply=False, max_deletions=MAX_DELETIONS):
    verify_runtime(data_path, getattr(api, "base_url", None))
    allocated, partitions = storage_snapshot(data_path)
    expiry = retention_days * 86400 * 1_000_000
    cutoff = int(time.time() * 1_000_000) - expiry
    reconcile_topics(api, partitions, expiry, apply)
    plan, projected = deletion_plan(allocated, partitions, max_bytes, cutoff)
    emit(action="plan", apply=apply, allocated_bytes=allocated, max_bytes=max_bytes,
         segments=len(plan), projected_bytes=projected, cutoff_microseconds=cutoff)
    if not apply:
        return
    for segment in plan[:max_deletions]:
        delete_segment(api, segment)
    allocated, partitions = storage_snapshot(data_path)
    pending, _ = deletion_plan(allocated, partitions, max_bytes, cutoff)
    emit(action="result", allocated_bytes=allocated, deleted_segments=min(len(plan), max_deletions),
         pending_segments=len(pending), max_bytes=max_bytes)
    if pending or allocated > max_bytes:
        raise RuntimeError("Storage policy is not satisfied; retry next cycle or inspect active segments")


def emit(**values):
    print(json.dumps(values, sort_keys=True), flush=True)


@contextlib.contextmanager
def policy_lock(path, apply):
    if not apply:
        yield
        return
    with path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def positive(value):
    value = int(value)
    if value <= 0:
        raise argparse.ArgumentTypeError("Must be positive")
    return value


def main():
    parser = argparse.ArgumentParser(description="Enforce Iggy disk and age retention through its API")
    parser.add_argument("--apply", action="store_true", help="Update topics and delete old sealed segments")
    parser.add_argument("--data-path", type=Path, default=Path("/etc/iggy/data/local_data/streams"))
    parser.add_argument("--url", default="http://127.0.0.1:3000")
    parser.add_argument("--max-bytes", type=positive, default=MAX_STORAGE_BYTES)
    parser.add_argument("--max-deletions", type=positive, default=MAX_DELETIONS)
    parser.add_argument("--lock-file", type=Path, default=Path("/run/echo-iggy-storage-policy/lock"))
    args = parser.parse_args()
    try:
        with policy_lock(args.lock_file, args.apply):
            verify_runtime(args.data_path, args.url)
            api = IggyApi(args.url, os.environ["IGGY_ROOT_USERNAME"], os.environ["IGGY_ROOT_PASSWORD"])
            run_policy(api, args.data_path, args.max_bytes, RETENTION_DAYS, args.apply, args.max_deletions)
    except Exception as error:
        emit(action="error", error=str(error))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
