#!/usr/bin/env python3

import argparse
import fcntl
import ipaddress
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

INSTANCE_PREFIX = "echo-ai-agent-"
TEMPLATE_NAME = "echo-ai-agent-019fc7f7-9770-7f83-9c1a-211af29b02e6"
PROFILE_NAME = "echo-ai-agent"
HARNESS_RELEASE = "2026.08.05.2"
RUNNER_PROTOCOL_VERSION = 1
NODE_VERSION = "24.19.0"
PI_VERSION = "0.83.0"
MAX_RUNNING = 6
AGENT_UID = 29720
AGENT_GID = 29720
MAX_INPUT_BYTES = 1024 * 1024
MAX_RUN_PAYLOAD_BYTES = 512 * 1024
MAX_EVENT_BYTES = 1024 * 1024
MAX_EVENT_CHARACTERS = 1024 * 1024
STDERR_CHUNK_CHARACTERS = 4096
STDERR_TAIL_BYTES = 8 * 1024
LOCK_PATH = Path("/run/lock/echo-ai-agent-dispatcher.lock")
UUID7_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
NAMESPACE_RE = re.compile(r"^echo-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$")
HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)
BASE_REQUEST_FIELDS = frozenset({"id", "operation"})
OPERATION_FIELDS = {
    "preflight": BASE_REQUEST_FIELDS | {"template_id"},
    "list": BASE_REQUEST_FIELDS,
    "status": BASE_REQUEST_FIELDS | {"agent_id"},
    "clone": BASE_REQUEST_FIELDS | {"agent_id", "template_id"},
    "start": BASE_REQUEST_FIELDS | {"agent_id"},
    "stop": BASE_REQUEST_FIELDS | {"agent_id", "timeout_seconds"},
    "destroy": BASE_REQUEST_FIELDS | {"agent_id"},
    "stats": BASE_REQUEST_FIELDS | {"agent_id"},
    "configure_proxies": BASE_REQUEST_FIELDS
    | {
        "agent_id",
        "echo_hostname",
        "echo_upstream",
        "provider_transport",
        "vllm_upstream",
    },
    "run_request": BASE_REQUEST_FIELDS | {"agent_id", "payload"},
    "test_connection": BASE_REQUEST_FIELDS | {"agent_id", "payload"},
}
ALLOWED_OPERATIONS = frozenset(OPERATION_FIELDS)
MUTATING_OPERATIONS = {
    "clone",
    "start",
    "stop",
    "destroy",
    "configure_proxies",
}


class DispatchError(Exception):
    pass


@dataclass(frozen=True)
class Request:
    request_id: str
    operation: str
    body: dict[str, Any]


def fail(message: str) -> NoReturn:
    raise DispatchError(message)


def run(
    args: list[str],
    *,
    input_text: str | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if check and result.returncode != 0:
        detail = result.stderr.strip().splitlines()
        suffix = f": {detail[-1]}" if detail else ""
        fail(f"command failed ({args[0]} {args[1] if len(args) > 1 else ''}){suffix}")
    return result


def run_json(args: list[str]) -> Any:
    result = run(args)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        fail(f"invalid JSON returned by {args[0]}")


def incus_versions() -> dict[str, str]:
    result = run(["incus", "version"])
    versions = {}
    for output_line in result.stdout.splitlines():
        label, separator, value = output_line.partition(":")
        key = label.strip().lower().replace(" ", "_")
        if separator and key in {"client_version", "server_version"} and value.strip():
            versions[key] = value.strip()
    if set(versions) != {"client_version", "server_version"}:
        fail("unexpected Incus version output")
    return versions


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), flush=True)


def parse_request(raw_line: bytes) -> Request:
    if len(raw_line) > MAX_INPUT_BYTES:
        fail("request exceeds input limit")
    try:
        body = json.loads(raw_line)
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("request must be valid UTF-8 JSON")
    if not isinstance(body, dict):
        fail("request must be a JSON object")
    request_id = body.get("id")
    operation = body.get("operation")
    if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
        fail("id must be a non-empty string of at most 128 characters")
    if not isinstance(operation, str) or operation not in ALLOWED_OPERATIONS:
        fail("operation is not allowed")
    if set(body) - OPERATION_FIELDS[operation]:
        fail("request contains unsupported fields")
    return Request(request_id=request_id, operation=operation, body=body)


def instance_name(body: dict[str, Any]) -> str:
    agent_id = body.get("agent_id")
    if not isinstance(agent_id, str) or not UUID7_RE.fullmatch(agent_id):
        fail("agent_id must be a lowercase UUIDv7")
    return f"{INSTANCE_PREFIX}{agent_id}"


def incus_instances() -> list[dict[str, Any]]:
    value = run_json(["incus", "list", "--format=json"])
    if not isinstance(value, list):
        fail("unexpected Incus instance list")
    return value


def instance_record(name: str) -> dict[str, Any] | None:
    return next((item for item in incus_instances() if item.get("name") == name), None)


def require_instance(name: str, namespace: str) -> dict[str, Any]:
    record = instance_record(name)
    if record is None:
        fail("agent instance does not exist")
    config = record.get("config") or {}
    if config.get("user.echo.ai.namespace") != namespace:
        fail("agent instance is owned by another namespace")
    if config.get("user.echo.ai.managed") != "true":
        fail("instance is not dispatcher-managed")
    return record


def agent_summary(record: dict[str, Any]) -> dict[str, Any]:
    config = record.get("config") or {}
    return {
        "name": record.get("name"),
        "status": str(record.get("status", "UNKNOWN")).lower(),
        "agent_id": config.get("user.echo.ai.agent_id"),
        "namespace": config.get("user.echo.ai.namespace"),
        "echo_hostname": config.get("user.echo.ai.echo_hostname"),
        "provider_transport": config.get("user.echo.ai.provider_transport"),
        "profiles": record.get("profiles") or [],
    }


def namespace_agents(namespace: str) -> list[dict[str, Any]]:
    agents = []
    for record in incus_instances():
        config = record.get("config") or {}
        if (
            str(record.get("name", "")).startswith(INSTANCE_PREFIX)
            and config.get("user.echo.ai.template.ready") != "true"
            and config.get("user.echo.ai.namespace") == namespace
            and config.get("user.echo.ai.managed") == "true"
        ):
            agents.append(agent_summary(record))
    return sorted(agents, key=lambda item: str(item["name"]))


def running_agent_count() -> int:
    count = 0
    for record in incus_instances():
        name = str(record.get("name", ""))
        config = record.get("config") or {}
        if (
            name.startswith(INSTANCE_PREFIX)
            and config.get("user.echo.ai.template.ready") != "true"
            and config.get("user.echo.ai.managed") == "true"
            and str(record.get("status", "")).upper() == "RUNNING"
        ):
            count += 1
    return count


def require_template(body: dict[str, Any]) -> dict[str, Any]:
    template_id = body.get("template_id")
    if template_id is None:
        name = TEMPLATE_NAME
    elif isinstance(template_id, str) and UUID7_RE.fullmatch(template_id):
        name = f"{INSTANCE_PREFIX}{template_id}"
    else:
        fail("template_id must be a lowercase UUIDv7")
    record = instance_record(name)
    if record is None:
        fail("selected template does not exist")
    config = record.get("config") or {}
    if config.get("user.echo.ai.template.ready") != "true":
        fail("selected template is not marked ready")
    if config.get("user.echo.ai.harness_release") != HARNESS_RELEASE:
        fail("selected template belongs to another harness release")
    if config.get("user.echo.ai.node_version") != NODE_VERSION:
        fail("selected template has an unexpected Node version")
    if config.get("user.echo.ai.pi_version") != PI_VERSION:
        fail("selected template has an unexpected Pi version")
    if config.get("user.echo.ai.guestapi_disabled") != "true":
        fail("selected template does not attest guest API isolation")
    if config.get("user.echo.ai.container_uid") != str(AGENT_UID):
        fail("selected template has an unexpected agent UID")
    if config.get("user.echo.ai.container_gid") != str(AGENT_GID):
        fail("selected template has an unexpected agent GID")
    if record.get("profiles") != [PROFILE_NAME]:
        fail("selected template does not use the dedicated agent profile")
    if str(record.get("status", "")).upper() != "STOPPED":
        fail("selected template must be stopped")
    return record


def parse_endpoint(value: Any, field: str) -> tuple[str, int]:
    if not isinstance(value, str) or len(value) > 260 or value.count(":") != 1:
        fail(f"{field} must be host:port")
    host, raw_port = value.rsplit(":", 1)
    try:
        port = int(raw_port)
    except ValueError:
        fail(f"{field} has an invalid port")
    if not 1 <= port <= 65535:
        fail(f"{field} has an invalid port")
    try:
        address = ipaddress.ip_address(host)
        if address.version != 4:
            fail(f"{field} supports IPv4 only")
    except ValueError:
        if not HOSTNAME_RE.fullmatch(host):
            fail(f"{field} has an invalid hostname")
    return host, port


def resolve_endpoint(value: Any, field: str) -> tuple[str, int]:
    host, port = parse_endpoint(value, field)
    try:
        address = ipaddress.ip_address(host)
        return str(address), port
    except ValueError:
        pass
    try:
        addresses = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
    except socket.gaierror:
        fail(f"{field} hostname did not resolve to IPv4")
    for address in addresses:
        resolved_host = address[4][0]
        try:
            resolved_address = ipaddress.ip_address(resolved_host)
        except ValueError:
            continue
        if resolved_address.version == 4:
            return str(resolved_address), port
    fail(f"{field} hostname did not resolve to IPv4")


def replace_proxy(name: str, device: str, listen_port: int, upstream: str) -> None:
    existing = run(
        ["incus", "config", "device", "get", name, device, "type"], check=False
    )
    settings = [
        "bind=instance",
        f"listen=tcp:127.0.0.1:{listen_port}",
        f"connect=tcp:{upstream}",
    ]
    if existing.returncode == 0:
        if existing.stdout.strip() != "proxy":
            fail(f"existing device {device} is not a proxy")
        run(["incus", "config", "device", "set", name, device, *settings])
    else:
        run(
            [
                "incus",
                "config",
                "device",
                "add",
                name,
                device,
                "proxy",
                *settings,
            ]
        )


def remove_proxy(name: str, device: str) -> None:
    existing = run(
        ["incus", "config", "device", "get", name, device, "type"], check=False
    )
    if existing.returncode != 0:
        return
    if existing.stdout.strip() != "proxy":
        fail(f"existing device {device} is not a proxy")
    run(["incus", "config", "device", "remove", name, device])


def op_preflight(namespace: str, body: dict[str, Any]) -> dict[str, Any]:
    server = incus_versions()
    template = require_template(body)
    template_name = str(template["name"])
    template_id = template_name.removeprefix(INSTANCE_PREFIX)
    return {
        "namespace": namespace,
        "incus": server,
        "template_id": template_id,
        "template_name": template_name,
        "template_ready": True,
        "running": running_agent_count(),
        "max_running": MAX_RUNNING,
    }


def op_list(namespace: str, _: dict[str, Any]) -> dict[str, Any]:
    return {"instances": namespace_agents(namespace)}


def op_status(namespace: str, body: dict[str, Any]) -> dict[str, Any]:
    record = require_instance(instance_name(body), namespace)
    return {"instance": agent_summary(record)}


def op_clone(namespace: str, body: dict[str, Any]) -> dict[str, Any]:
    name = instance_name(body)
    if instance_record(name) is not None:
        fail("agent instance already exists")
    template = require_template(body)
    template_name = str(template["name"])
    run(["incus", "copy", template_name, name, "--profile", PROFILE_NAME])
    try:
        run(
            [
                "incus",
                "config",
                "set",
                name,
                "user.echo.ai.managed=true",
                f"user.echo.ai.namespace={namespace}",
                f"user.echo.ai.agent_id={body['agent_id']}",
                f"user.echo.ai.template_source={template_name}",
                "user.echo.ai.template.ready=false",
                "boot.autostart=false",
                "security.protection.delete=false",
            ]
        )
        record = require_instance(name, namespace)
        if (record.get("config") or {}).get("user.echo.ai.template.ready") != "false":
            fail("agent instance retained the template-ready marker")
    except DispatchError:
        run(
            [
                "incus",
                "config",
                "set",
                name,
                "security.protection.delete=false",
            ],
            check=False,
        )
        run(["incus", "delete", name], check=False)
        raise
    return {"instance": agent_summary(record)}


def op_start(namespace: str, body: dict[str, Any]) -> dict[str, Any]:
    name = instance_name(body)
    record = require_instance(name, namespace)
    if str(record.get("status", "")).upper() == "RUNNING":
        return {"instance": agent_summary(record), "changed": False}
    if running_agent_count() >= MAX_RUNNING:
        fail("running-container limit reached")
    run(["incus", "start", name])
    return {"instance": agent_summary(require_instance(name, namespace)), "changed": True}


def op_stop(namespace: str, body: dict[str, Any]) -> dict[str, Any]:
    name = instance_name(body)
    record = require_instance(name, namespace)
    if str(record.get("status", "")).upper() == "STOPPED":
        return {"instance": agent_summary(record), "changed": False}
    timeout = body.get("timeout_seconds", 30)
    if not isinstance(timeout, int) or not 1 <= timeout <= 120:
        fail("timeout_seconds must be between 1 and 120")
    run(["incus", "stop", name, "--timeout", str(timeout), "--force"])
    return {"instance": agent_summary(require_instance(name, namespace)), "changed": True}


def op_destroy(namespace: str, body: dict[str, Any]) -> dict[str, Any]:
    name = instance_name(body)
    record = require_instance(name, namespace)
    if str(record.get("status", "")).upper() != "STOPPED":
        fail("agent instance must be stopped before destroy")
    run(["incus", "delete", name])
    return {"destroyed": True, "name": name}


def op_stats(namespace: str, body: dict[str, Any]) -> dict[str, Any]:
    name = instance_name(body)
    record = require_instance(name, namespace)
    state = run_json(["incus", "query", f"/1.0/instances/{name}/state"])
    if not isinstance(state, dict):
        fail("unexpected Incus instance state")
    return {
        "name": name,
        "status": str(state.get("status", record.get("status", "UNKNOWN"))).lower(),
        "cpu": state.get("cpu"),
        "memory": state.get("memory"),
        "disk": state.get("disk"),
        "processes": state.get("processes"),
    }


def op_configure_proxies(namespace: str, body: dict[str, Any]) -> dict[str, Any]:
    name = instance_name(body)
    record = require_instance(name, namespace)
    if str(record.get("status", "")).upper() != "RUNNING":
        fail("agent instance must be running to configure proxies")
    echo_hostname = body.get("echo_hostname")
    if not isinstance(echo_hostname, str) or not HOSTNAME_RE.fullmatch(echo_hostname):
        fail("echo_hostname must be a lowercase fully qualified hostname")
    provider_transport = body.get("provider_transport", "direct_http")
    if provider_transport not in {"direct_http", "echo_gateway"}:
        fail("provider_transport is not supported")
    echo_host, echo_port = resolve_endpoint(body.get("echo_upstream"), "echo_upstream")
    vllm_endpoint = None
    if provider_transport == "direct_http":
        vllm_endpoint = resolve_endpoint(body.get("vllm_upstream"), "vllm_upstream")
    elif body.get("vllm_upstream") is not None:
        fail("vllm_upstream is not allowed for echo_gateway")
    replace_proxy(name, "echo-upstream", 18443, f"{echo_host}:{echo_port}")
    if vllm_endpoint is None:
        remove_proxy(name, "vllm-upstream")
    else:
        vllm_host, vllm_port = vllm_endpoint
        replace_proxy(name, "vllm-upstream", 18000, f"{vllm_host}:{vllm_port}")
    run(
        [
            "incus",
            "exec",
            name,
            "--",
            "/usr/local/sbin/echo-ai-agent-configure-network",
            echo_hostname,
        ]
    )
    settings = [
        "incus",
        "config",
        "set",
        name,
        f"user.echo.ai.echo_hostname={echo_hostname}",
        f"user.echo.ai.echo_upstream={echo_host}:{echo_port}",
        f"user.echo.ai.provider_transport={provider_transport}",
    ]
    if vllm_endpoint is not None:
        vllm_host, vllm_port = vllm_endpoint
        settings.append(f"user.echo.ai.vllm_upstream={vllm_host}:{vllm_port}")
    else:
        run(
            [
                "incus",
                "config",
                "unset",
                name,
                "user.echo.ai.vllm_upstream",
            ],
            check=False,
        )
    run(settings)
    return {"instance": agent_summary(require_instance(name, namespace))}


def read_runner_event_line(stream: Any) -> str:
    output_line = stream.readline(MAX_EVENT_CHARACTERS + 1)
    if not output_line:
        return ""
    if len(output_line.encode()) > MAX_EVENT_BYTES or len(output_line) > MAX_EVENT_CHARACTERS:
        while output_line and not output_line.endswith("\n"):
            output_line = stream.readline(MAX_EVENT_CHARACTERS + 1)
        fail("runner event exceeds output limit")
    return output_line


SECRET_LINE_RE = re.compile(
    r"(?i)(bootstrap_?token|authorization|cookie|api[_-]?key|password|token)"
    r"([\"']?\s*[:=]\s*[\"']?)[^\r\n]+"
)
BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
BOOTSTRAP_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])")


def redact_runner_stderr(value: str) -> str:
    value = BEARER_RE.sub("Bearer [REDACTED]", value)
    value = SECRET_LINE_RE.sub(
        lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", value
    )
    return BOOTSTRAP_TOKEN_RE.sub("[REDACTED]", value)


def drain_runner_stderr(stream: Any) -> str:
    tail = bytearray()
    while chunk := stream.read(STDERR_CHUNK_CHARACTERS):
        tail.extend(chunk.encode("utf-8", errors="replace"))
        if len(tail) > STDERR_TAIL_BYTES:
            del tail[:-STDERR_TAIL_BYTES]
    redacted = redact_runner_stderr(tail.decode("utf-8", errors="replace"))
    return redacted.encode("utf-8")[-STDERR_TAIL_BYTES:].decode(
        "utf-8", errors="replace"
    )


def validate_runner_hello(event: Any) -> None:
    if not isinstance(event, dict) or event.get("type") != "runner_hello":
        fail("runner did not provide a compatibility handshake")
    if event.get("protocolVersion") != RUNNER_PROTOCOL_VERSION:
        fail("runner protocol version is incompatible")
    if event.get("harnessRelease") != HARNESS_RELEASE:
        fail("runner harness release is incompatible")


def runner_failure(
    request_id: str, exit_status: int, reason: str, stderr_tail: str
) -> str:
    stderr_tail = stderr_tail.strip() or "<empty>"
    return (
        f"{reason}; dispatcher_request_id={request_id}; "
        f"exit_status={exit_status}; runner_stderr_tail={stderr_tail}"
    )


def run_agent_command(
    request: Request, namespace: str, command_args: list[str]
) -> dict[str, Any]:
    name = instance_name(request.body)
    record = require_instance(name, namespace)
    if str(record.get("status", "")).upper() != "RUNNING":
        fail("agent instance must be running")
    payload = request.body.get("payload")
    if not isinstance(payload, dict):
        fail("payload must be a JSON object")
    payload_text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    if len(payload_text.encode()) > MAX_RUN_PAYLOAD_BYTES:
        fail("payload exceeds runner input limit")
    process = subprocess.Popen(
        [
            "incus",
            "exec",
            name,
            "--user",
            str(AGENT_UID),
            "--group",
            str(AGENT_GID),
            "--cwd",
            "/home/echo",
            "--env",
            "HOME=/home/echo",
            "--",
            "/usr/local/bin/echo-ai-agent-runner",
            *command_args,
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None

    stderr_tail: list[str] = []

    def drain_stderr() -> None:
        assert process.stderr is not None
        stderr_tail.append(drain_runner_stderr(process.stderr))

    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()
    runner_error: str | None = None
    status = -1
    try:
        process.stdin.write(payload_text + "\n")
        process.stdin.close()
        hello_seen = False
        while True:
            output_line = read_runner_event_line(process.stdout)
            if not output_line:
                break
            try:
                event = json.loads(output_line)
            except json.JSONDecodeError:
                fail("runner returned invalid JSONL")
            if not isinstance(event, dict):
                fail("runner event must be a JSON object")
            if not hello_seen:
                validate_runner_hello(event)
                hello_seen = True
                continue
            emit({"id": request.request_id, "ok": True, "event": event})
        status = process.wait()
        if not hello_seen:
            runner_error = "runner ended before its compatibility handshake"
    except DispatchError as error:
        runner_error = str(error)
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        status = process.returncode if process.returncode is not None else status
        stderr_thread.join()
    if runner_error or status != 0:
        fail(
            runner_failure(
                request.request_id,
                status,
                runner_error or "agent runner failed",
                stderr_tail[0] if stderr_tail else "",
            )
        )
    return {"exit_code": status}


def dispatch(request: Request, namespace: str) -> dict[str, Any]:
    handlers = {
        "preflight": op_preflight,
        "list": op_list,
        "status": op_status,
        "clone": op_clone,
        "start": op_start,
        "stop": op_stop,
        "destroy": op_destroy,
        "stats": op_stats,
        "configure_proxies": op_configure_proxies,
    }
    if request.operation == "run_request":
        return run_agent_command(request, namespace, [])
    if request.operation == "test_connection":
        return run_agent_command(request, namespace, ["--test-connection"])
    return handlers[request.operation](namespace, request.body)


def serve(namespace: str) -> int:
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("a", encoding="utf-8") as lock_file:
        while True:
            raw_line = sys.stdin.buffer.readline(MAX_INPUT_BYTES + 1)
            if not raw_line:
                break
            request_id: str | None = None
            try:
                if len(raw_line) > MAX_INPUT_BYTES:
                    while raw_line and not raw_line.endswith(b"\n"):
                        raw_line = sys.stdin.buffer.readline(MAX_INPUT_BYTES + 1)
                    fail("request exceeds input limit")
                request = parse_request(raw_line)
                request_id = request.request_id
                if request.operation in MUTATING_OPERATIONS:
                    fcntl.flock(lock_file, fcntl.LOCK_EX)
                    try:
                        result = dispatch(request, namespace)
                    finally:
                        fcntl.flock(lock_file, fcntl.LOCK_UN)
                else:
                    result = dispatch(request, namespace)
                emit({"id": request_id, "ok": True, "done": True, "result": result})
            except DispatchError as error:
                emit(
                    {
                        "id": request_id,
                        "ok": False,
                        "done": True,
                        "error": str(error),
                    }
                )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--namespace", required=True)
    args = parser.parse_args()
    if not NAMESPACE_RE.fullmatch(args.namespace):
        print("invalid dispatcher namespace", file=sys.stderr)
        return 2
    os.umask(0o077)
    signal.signal(signal.SIGTERM, lambda _signum, _frame: sys.exit(130))
    signal.signal(signal.SIGINT, lambda _signum, _frame: sys.exit(130))
    try:
        return serve(args.namespace)
    except BrokenPipeError:
        return 130


if __name__ == "__main__":
    sys.exit(main())
