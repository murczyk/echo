#!/usr/bin/env python3
"""Owned PostgreSQL wire faults; suppress only a confirmed selected COMMIT ack."""

import json
import os
import tempfile
from pathlib import Path
import socket
import socketserver
import struct
import threading
import uuid

def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def private_write(path, text):
    require(not path.is_symlink(), "Refusing a symlinked private file")
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".new", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            output.write(text)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def receive(sock, count):
    value = b""
    while len(value) < count:
        part = sock.recv(count - len(value))
        if not part:
            raise EOFError()
        value += part
    return value


def packet(sock):
    kind = receive(sock, 1)
    length = receive(sock, 4)
    count = struct.unpack("!I", length)[0]
    require(4 <= count <= 64 * 1024 * 1024, "Invalid owned PostgreSQL frame length")
    return kind, length, receive(sock, count - 4)


def publication_query(sql):
    sql = b" ".join(sql.lower().split())
    return (sql.startswith(b"update device_upload_finalization_job set status='completed'")
            and b"winning_attempt_id=" in sql and b"result=" in sql)


def write_intent_query(sql):
    sql = b" ".join(sql.lower().split())
    return sql.startswith(b"update device_upload_finalization_attempt a set phase='write_intent'")


def bind_identity(body, index=0):
    portal, statement, body = body.split(b"\0", 2)
    count = struct.unpack("!H", body[:2])[0]
    body = body[2 + count * 2:]
    parameters = struct.unpack("!H", body[:2])[0]
    if not parameters:
        return portal, statement, None
    body = body[2:]
    for _ in range(index):
        size = struct.unpack("!i", body[:4])[0]
        body = body[4 + max(size, 0):]
    size = struct.unpack("!i", body[:4])[0]
    value = body[4:4 + max(size, 0)]
    try:
        identity = str(uuid.UUID(bytes=value)) if size == 16 else str(uuid.UUID(value.decode()))
    except (ValueError, UnicodeDecodeError):
        identity = None
    return portal, statement, identity


class Proxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, root, environment):
        self.root, self.environment = root, environment
        self.lock = threading.Lock()
        self.sequence = 0
        self.cancel_keys = set()
        super().__init__(("127.0.0.1", environment["pg_proxy_port"]), Connection)

    def control(self):
        return json.loads((self.root / "pg-control.json").read_text())

    def event(self, value):
        with self.lock:
            with (self.root / "pg-events.jsonl").open("a") as output:
                output.write(json.dumps(value) + "\n")

    def claim(self, identity, target):
        with self.lock:
            control = self.control()
            if control.get("mode") not in ("drop-commit", "drop-commit-and-block") or control.get("job_id") != identity or control.get("target", "publication") != target:
                return None
            mode = control["mode"]
            private_write(self.root / "pg-control.json", json.dumps({**control, "mode": "claimed"}))
            return mode


class Connection(socketserver.BaseRequestHandler):
    def handle(self):
        server = self.server
        upstream = None
        with server.lock:
            server.sequence += 1
            connection = server.sequence
        try:
            if server.control()["mode"] == "unavailable":
                server.event({"event": "connection_unavailable", "connection": connection})
                return
            length = receive(self.request, 4)
            count = struct.unpack("!I", length)[0]
            require(8 <= count <= 65536, "Invalid owned PostgreSQL startup length")
            body = receive(self.request, count - 4)
            if body in (struct.pack("!I", 80877103), struct.pack("!I", 80877104)):
                self.request.sendall(b"N")
                length = receive(self.request, 4)
                count = struct.unpack("!I", length)[0]
                require(8 <= count <= 65536, "Invalid owned PostgreSQL startup length")
                body = receive(self.request, count - 4)
            if body[:4] == struct.pack("!I", 80877102):
                with server.lock:
                    allowed = body[4:] in server.cancel_keys
                require(allowed, "Refusing a foreign PostgreSQL cancellation key")
            else:
                require(body[:4] == struct.pack("!I", 196608), "Only PostgreSQL protocol 3 is supported")
                fields = body[4:].split(b"\0")
                values = dict(zip(fields[::2], fields[1::2]))
                require(values.get(b"database") == server.environment["files_db"].encode(),
                               "Refusing proxy access to a foreign database")
            upstream = socket.create_connection(("127.0.0.1", server.environment["pg_port"]), timeout=10)
            upstream.settimeout(None)
            upstream.sendall(length + body)
            state = {"statements": {}, "portals": {}, "executing": None, "published": None, "target": None, "drop": None}

            def frontend():
                try:
                    while True:
                        kind, length, body = packet(self.request)
                        if server.control()["mode"] == "unavailable":
                            server.event({"event": "query_unavailable", "connection": connection})
                            return
                        if kind == b"P":
                            name, sql, _types = body.split(b"\0", 2)
                            state["statements"][name] = "write-intent" if write_intent_query(sql) else "publication" if publication_query(sql) else None
                        elif kind == b"B":
                            portal, statement, identity = bind_identity(body)
                            target = state["statements"].get(statement)
                            if target == "write-intent":
                                portal, statement, identity = bind_identity(body, 1)
                            state["portals"][portal] = (identity, target) if target else None
                        elif kind == b"E":
                            portal = body.split(b"\0", 1)[0]
                            state["executing"] = state["portals"].get(portal)
                        upstream.sendall(kind + length + body)
                except (EOFError, OSError, ValueError, RuntimeError, struct.error):
                    pass
                finally:
                    try:
                        upstream.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    try:
                        self.request.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

            threading.Thread(target=frontend, daemon=True).start()
            while True:
                kind, length, body = packet(upstream)
                if kind == b"K":
                    with server.lock:
                        server.cancel_keys.add(body)
                if kind == b"C" and body == b"UPDATE 1\0" and state["executing"]:
                    state["published"], state["target"] = state["executing"]
                    server.event({"event": state["target"] + "_update", "connection": connection, "job_id": state["published"]})
                if kind == b"C" and body == b"COMMIT\0" and state["published"]:
                    state["drop"] = server.claim(state["published"], state["target"])
                if state["drop"]:
                    if kind == b"Z":
                        require(body == b"I", "COMMIT loss requires confirmed idle backend")
                        server.event({"event": "commit_ack_suppressed", "connection": connection,
                                      "job_id": state["published"], "target": state["target"], "command": "COMMIT", "backend_ready": "I"})
                        mode = "unavailable" if state["drop"] == "drop-commit-and-block" else "normal"
                        with server.lock:
                            private_write(server.root / "pg-control.json", json.dumps({"mode": mode}))
                        self.request.shutdown(socket.SHUT_RDWR)
                        return
                else:
                    self.request.sendall(kind + length + body)
                    if kind == b"Z":
                        state["executing"] = None
                        if body == b"I":
                            state["published"] = None
        except (EOFError, OSError, ValueError, RuntimeError, struct.error) as error:
            server.event({"event": "connection_closed", "connection": connection, "reason": type(error).__name__})
        finally:
            if upstream:
                upstream.close()


def serve(root, environment):
    with Proxy(Path(root), environment) as proxy:
        proxy.serve_forever()
