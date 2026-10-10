#!/usr/bin/env python3
"""Owned native worker faults against private MinIO and a mock Alpine boundary."""
import argparse
import base64
import concurrent.futures
import email.parser
import email.policy
import hashlib
import http.client
import http.cookiejar
import io
import json
import os
from pathlib import Path
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import file_preview_harness as h


def eventually(predicate, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError("Fault experiment did not reach its behavioral condition")


def receive(sock, length):
    data = b""
    while len(data) < length:
        chunk = sock.recv(length - len(data))
        if not chunk:
            raise EOFError()
        data += chunk
    return data


class PgProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class PgConnection(socketserver.BaseRequestHandler):
    def handle(self):
        server = self.server
        upstream = socket.create_connection(("127.0.0.1", server.upstream))
        try:
            packet = receive(self.request, 4)
            body = receive(self.request, struct.unpack("!I", packet)[0] - 4)
            if body == struct.pack("!I", 80877103):
                self.request.sendall(b"N")
                packet = receive(self.request, 4)
                body = receive(self.request, struct.unpack("!I", packet)[0] - 4)
            upstream.sendall(packet + body)
            state = {"publish": False, "drop": False, "unknown": False, "statements": set()}

            def frontend():
                try:
                    while True:
                        kind = receive(self.request, 1)
                        length = receive(self.request, 4)
                        body = receive(self.request, struct.unpack("!I", length)[0] - 4)
                        if kind in (b"P", b"Q") and server.control["mode"] == "mutate_source_device":
                            guard = b"where entry.device_id = $1 and entry.id = $2"
                            if guard in body:
                                body = body.replace(guard, b"where ($1::uuid is not null) and entry.id = $2")
                                length = struct.pack("!I", len(body) + 4)
                                server.events.append({"event": "source_device_guard_removed"})
                        if kind in (b"P", b"Q") and b"select * from file_preview where generation=$1" in body and server.committed.is_set():
                            server.events.append({"event": "authoritative_load_after_lost_commit_ack"})
                        if kind in (b"P", b"Q") and b"set state='ready',lease=null" in body:
                            state["publish"] = True
                            if kind == b"P":
                                state["statements"].add(body.split(b"\0", 1)[0])
                            mode = server.control["mode"]
                            server.events.append({"event": "publish_observed", "mode": mode})
                            if mode == "block":
                                server.blocked.set()
                                server.release.wait(90)
                                if server.control.get("discard"):
                                    return
                            if mode == "unknown_commit":
                                state["unknown"] = True
                        if kind == b"B" and body.split(b"\0", 2)[1] in state["statements"]:
                            state["publish"] = True
                        upstream.sendall(kind + length + body)
                except (EOFError, OSError):
                    pass
                finally:
                    try:
                        upstream.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

            forwarding = threading.Thread(target=frontend, daemon=True)
            forwarding.start()
            while True:
                kind = receive(upstream, 1)
                length = receive(upstream, 4)
                body = receive(upstream, struct.unpack("!I", length)[0] - 4)
                if state["publish"] and state["unknown"] and kind == b"C" and body == b"UPDATE 1\0":
                    state["drop"] = True
                    server.control["mode"] = "normal"
                if state["drop"]:
                    if kind == b"C":
                        server.events.append({"event": "suppressed_command_complete", "tag": body.rstrip(b"\0").decode()})
                    if kind == b"Z":
                        assert body == b"I", "commit-loss injection requires idle/autocommitted ReadyForQuery"
                        server.events.append({"event": "suppressed_ready_for_query", "transaction": body.decode()})
                        server.committed.set()
                        self.request.shutdown(socket.SHUT_RDWR)
                        break
                else:
                    if state["publish"] and kind == b"C":
                        server.events.append({"event": "forwarded_command_complete", "tag": body.rstrip(b"\0").decode()})
                    self.request.sendall(kind + length + body)
                    if kind == b"Z":
                        state["publish"] = False
        except (EOFError, OSError):
            pass
        finally:
            upstream.close()


class Api:
    def __init__(self, origin, actor):
        self.origin = origin
        self.cookie = ""
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
        self.call("POST", "/api/user/test-api-login", {"user": actor["login"], "password": actor["password"]})
        self.cookie = "; ".join(c.name + "=" + c.value for c in jar)
        assert self.cookie

    def call(self, method, path, data=None, headers=None, expected=200):
        headers = {"Cookie": self.cookie, **(headers or {})}
        if isinstance(data, dict):
            data = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.origin + path, data=data, method=method, headers=headers)
        try:
            response = self.opener.open(request, timeout=90)
        except urllib.error.HTTPError as error:
            response = error
        body = response.read()
        assert response.code == expected, (method, path, response.code, expected, body[:180])
        return response, body

    def json(self, method, path, data=None, expected=200):
        return json.loads(self.call(method, path, data, expected=expected)[1])


def stop(root, env, role, force=False):
    record = env["processes"].get(role)
    if record and h.owned_process(record, root, env):
        h.signal_group(record, signal.SIGKILL if force else signal.SIGTERM)
        eventually(lambda: not h.owned_process(record, root, env), 20)
        h.save(root, env)


def spawn(root, env, role, config):
    runtime = h.runtime_env(root, env)
    runtime.update(ECHO_CONFIG_PATH=str(config), ECHO_DEV_BACK_REST_ONLY="true",
                   RUST_LOG="wdintel_rs::devices::files::preview=info,warn")
    with (root / f"{role}.log").open("a") as log:
        process = subprocess.Popen([sys.executable, __file__, "--root", str(root), "--role", role],
                                   cwd=h.REPO, env=runtime, stdout=log, stderr=log, start_new_session=True)
    env["processes"][role] = {"pid": process.pid, "started": h.process_identity(process.pid)}
    assert env["processes"][role]["started"]
    h.save(root, env)


def qualify_mutation(root, env, binary):
    binary = Path(binary).resolve()
    assert binary.parent == root and binary.is_file()
    config = tomllib.loads((root / "config-a.toml").read_text())
    proxy = PgProxy(("127.0.0.1", 0), PgConnection)
    proxy.upstream = config["file_registry"]["pg_port"]
    proxy.control = {"mode": "mutate_source_device"}
    proxy.events = []
    proxy.committed = threading.Event()
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    config["file_registry"]["pg_port"] = proxy.server_address[1]
    path = root / "config-sensitivity.toml"
    h.private_write(path, h.toml_text(config))
    runtime = h.runtime_env(root, env)
    runtime["ECHO_CONFIG_PATH"] = str(path)
    runtime["WDINTEL_SKIP_TEST_DB_INIT"] = "1"
    try:
        result = subprocess.run([str(binary), "acceptance_historical_endpoint_matrix_rechecks_access_and_source", "--nocapture"],
                                cwd=h.REPO / "wdintel-rs", env=runtime, text=True, capture_output=True)
        output = result.stdout + result.stderr
        h.private_write(root / "backend-safety-mutant.log", output)
        assert result.returncode != 0 and "phase=other_device" in output
        assert "left: 200" in output and "right: 404" in output
        assert proxy.events
        h.private_write(root / "backend-safety-mutation-proof.json", json.dumps({"method": "isolated PostgreSQL wire mutation removed exact source-device WHERE guard", "original_predicate": "where entry.device_id = $1 and entry.id = $2", "mutated_predicate": "where ($1::uuid is not null) and entry.id = $2", "label": "retrospective regression sensitivity; not historical TDD RED", "test_binary_sha256": hashlib.file_digest(binary.open("rb"), "sha256").hexdigest(), "exit_code": result.returncode, "behavioral_failure": "wrong-device original GET returned200 instead of404", "query_mutations": len(proxy.events), "production_source_unchanged": True}, indent=2) + "\n")
        print("PASS retrospective sensitivity: removed query guard reaches wrong-device behavioral assertion (200 != 404)")
    finally:
        proxy.shutdown()


def main(root, env):
    for name in (env["main_db"], env["files_db"]):
        assert h.sql(root, env, f"select shobj_description(oid,'pg_database') from pg_database where datname='{name}'") == f"echo-device-file-preview:{env['run']}"
    stop(root, env, "bgworker")
    stop(root, env, "api-a")
    stop(root, env, "api-b")
    h.sql(root, env, "update file_preview set is_current=false,state='retired',lease=null,lease_until=null,heartbeat_at=null,cleanup_after=greatest(now(),coalesce(attempt_deadline,now())+interval '1 hour') where is_current", env["files_db"])
    source = (h.REPO / "wdintel-web/tests/e2e/fixtures/device-file-preview/map.gpx").read_bytes()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("doc.kml", '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><Point><coordinates>30,50,0</coordinates></Point></Placemark></Document></kml>')
    kmz = output.getvalue()
    mock_events = []

    class Mock(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, body, content_type="application/json", code=200):
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            if self.path == "/api/upload-task":
                multipart = email.parser.BytesParser(policy=email.policy.default).parsebytes(
                    ("Content-Type: " + self.headers["Content-Type"] + "\r\nMIME-Version: 1.0\r\n\r\n").encode() + body)
                received = [part.get_payload(decode=True) for part in multipart.iter_parts() if part.get_filename()]
                assert received == [source]
                mock_events.append({"event": "upload", "source_sha256": hashlib.sha256(source).hexdigest()})
                self.reply(b'"owned-fault-receipt"')
            else:
                assert self.path == "/api/task-status-batch"
                self.reply(json.dumps({"statuses": [{"receipt": receipt, "started": True, "completed": True, "is_ok": True} for receipt in json.loads(body)["receipts"]]}).encode())

        def do_GET(self):
            assert self.path.startswith("/api/download-task/")
            self.reply(kmz, "application/vnd.google-earth.kmz")

    mock = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    s3_control = {"fail_delete": False, "hold_key": None}
    read_held, read_release = threading.Event(), threading.Event()
    s3_events = []

    class S3Proxy(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def forward(self):
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                payload = bytearray()
                while length := int(self.rfile.readline().strip().split(b";", 1)[0], 16):
                    payload.extend(self.rfile.read(length))
                    assert self.rfile.read(2) == b"\r\n"
                assert self.rfile.readline() == b"\r\n"
                payload = bytes(payload)
            else:
                payload = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.command == "DELETE" and s3_control["fail_delete"]:
                s3_events.append({"method": "DELETE", "path": self.path, "status": 503})
                self.send_response(503)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            headers = {key: value for key, value in self.headers.items() if key.lower() not in ("transfer-encoding", "connection", "content-length")}
            headers["Content-Length"] = str(len(payload))
            connection = http.client.HTTPConnection("127.0.0.1", env["s3_port"], timeout=30)
            try:
                connection.request(self.command, self.path, payload, headers)
                response = connection.getresponse()
                body = response.read()
                if self.command == "GET" and s3_control["hold_key"] and self.path.endswith(s3_control["hold_key"]):
                    read_held.set()
                    assert read_release.wait(30)
                if self.command == "DELETE":
                    s3_events.append({"method": "DELETE", "path": self.path, "status": response.status})
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in ("transfer-encoding", "connection", "content-length"):
                        self.send_header(key, value)
                self.send_header("Content-Length", response.getheader("Content-Length", "0") if self.command == "HEAD" else str(len(body)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)
            finally:
                connection.close()

        do_GET = do_HEAD = do_PUT = do_POST = do_DELETE = forward

    s3_proxy = ThreadingHTTPServer(("127.0.0.1", 0), S3Proxy)
    threading.Thread(target=s3_proxy.serve_forever, daemon=True).start()
    config = tomllib.loads((root / "config-a.toml").read_text())
    config["alpine_converter_url"] = f"http://127.0.0.1:{mock.server_port}"
    config["s3_config"]["s3_endpoint"] = f"http://127.0.0.1:{s3_proxy.server_port}"
    api_config = root / "config-safety-api.toml"
    h.private_write(api_config, h.toml_text(config))
    proxy = PgProxy(("127.0.0.1", 0), PgConnection)
    proxy.upstream = config["file_registry"]["pg_port"]
    proxy.control = {"mode": "normal", "discard": False}
    proxy.events = []
    proxy.blocked, proxy.release, proxy.committed = threading.Event(), threading.Event(), threading.Event()
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    config["file_registry"]["pg_port"] = proxy.server_address[1]
    config["s3_config"]["s3_endpoint"] = f"http://127.0.0.1:{s3_proxy.server_port}"
    worker_config = root / "config-safety-worker.toml"
    h.private_write(worker_config, h.toml_text(config))
    spawn(root, env, "safety-api", api_config)
    origin = f"http://127.0.0.1:{env['api_a_port']}"
    h.wait_url(origin + "/api/ping")
    actor = json.loads((root / "fixtures-private.json").read_text())["actors"]["admin"]
    api = Api(origin, actor)
    # The bootstrap administrator already has system access; add the established
    # Cyber role only to this owned identity for actual Device/FileSync/TUS APIs.
    h.sql(root, env, f"update login set roles='[\"Admin\",\"Api\",\"Cyber\"]'::jsonb where login='{actor['login']}'", env["main_db"])
    settings = api.json("POST", "/api/system-settings/current", {})
    if not settings["devices_section_enabled"]:
        settings.pop("id")
        settings["devices_section_enabled"] = True
        settings["echo_restapi_error_discord_webhook_url"] = None
        created = api.json("POST", "/api/admin/system-settings/create", settings)
        api.json("POST", "/api/admin/system-settings/activate", {"id": created["id"]})
    device = api.json("POST", "/api/device/create", {"name": "Owned safety faults"})["id"]
    evidence = {"runtime": "native API/worker + owned PostgreSQL/Redis/private MinIO; mock Alpine returns predetermined KMZ", "binary_sha256": hashlib.file_digest((h.REPO / "target/debug/wdintel-rs").open("rb"), "sha256").hexdigest(), "source_sha256": hashlib.sha256(source).hexdigest(), "result_sha256": hashlib.sha256(kmz).hexdigest(), "cases": []}

    def sql(statement):
        return h.sql(root, env, statement, env["files_db"])

    def row(generation):
        return json.loads(sql(f"select row_to_json(p) from file_preview p where generation='{generation}'"))

    def create(name):
        item = api.json("POST", "/api/device/files/sync", {"device_id": device, "files": [{"absolute_path": f"C:\\safety\\{name}.gpx", "mime_type": "application/gpx+xml", "extension": "gpx", "file_metadata_created_at": None, "file_metadata_modified_at": None, "source_file_state": None}]})["results"][0]
        assert item["status"] == "accepted"
        file = item["file"]
        path = f"/api/device/files/{device}/{file['file_id']}/revisions/{file['revision']}"
        response, _ = api.call("POST", path + "/content-uploads", headers={"Tus-Resumable": "1.0.0", "Upload-Length": str(len(source)), "Upload-Metadata": "sha256 " + base64.b64encode(hashlib.sha256(source).digest()).decode()}, expected=201)
        location = response.headers["Location"]
        api.call("PATCH", location, source, {"Tus-Resumable": "1.0.0", "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"}, 204)
        assert json.loads(api.call("POST", location + "/complete", headers={"Tus-Resumable": "1.0.0"})[1])["status"] == "completed"
        assert api.call("GET", path + "/content")[1] == source
        snapshot = sql(f"select row_to_json(c) from file_content c where file_id='{file['file_id']}' and revision={file['revision']}")
        return path, file, snapshot

    def unchanged(path, file, snapshot):
        assert api.call("GET", path + "/content")[1] == source
        assert sql(f"select row_to_json(c) from file_content c where file_id='{file['file_id']}' and revision={file['revision']}") == snapshot

    def prepare(path):
        return api.json("POST", path + "/preview/geodata", expected=202)["generation"]

    try:
        path, file, snapshot = create("after-put")
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            admitted = list(pool.map(lambda _: prepare(path), range(8)))
        assert len(set(admitted)) == 1
        old = admitted[0]
        proxy.control["mode"] = "block"
        spawn(root, env, "safety-worker", worker_config)
        assert proxy.blocked.wait(50)
        old_row = row(old)
        assert old_row["state"] == "running" and old_row["result_size_bytes"] is None
        ciphertext = h.s3_request(root, env, "GET", old_row["output_object_key"])
        assert ciphertext and ciphertext != kmz and not ciphertext.startswith(b"PK")
        stop(root, env, "safety-worker", force=True)
        killed = time.monotonic()
        proxy.control.update(mode="normal", discard=True)
        proxy.release.set()
        eventually(lambda: sql(f"select count(*) from pg_stat_activity where datname='{env['files_db']}' and query like 'update file_preview p set state=%ready%' and state='active'") == "0")
        spawn(root, env, "safety-worker", worker_config)
        new_row = eventually(lambda: next((p for p in json.loads(sql(f"select coalesce(json_agg(p),'[]') from file_preview p where file_id='{file['file_id']}' and is_current and state='ready'")) if p["generation"] != old), None), 200)
        takeover = round(time.monotonic() - killed, 3)
        assert takeover >= 100
        assert new_row["attempt"] == 2 and new_row["run_id"] == old_row["run_id"] and new_row["output_object_key"] != old_row["output_object_key"]
        status = api.json("GET", path + "/preview/geodata")
        assert api.call("GET", status["result_url"])[1] == kmz
        api.call("GET", path + f"/preview/geodata/{old}/content", expected=409)
        unchanged(path, file, snapshot)
        assert h.s3_request(root, env, "GET", old_row["output_object_key"]) == ciphertext
        evidence["cases"].append({"case": "after_put_process_kill_real_lease_takeover", "old": old, "new": new_row["generation"], "takeover_seconds": takeover, "configured_lease_seconds": 120, "lease_until_at_crash": old_row["lease_until"], "attempt_before": old_row["attempt"], "attempt_after": new_row["attempt"], "run_preserved": True, "output_key_changed": True, "converter_version": new_row["converter_version"], "persisted_ciphertext_before_crash": len(ciphertext), "old_url_status": 409, "original_unchanged": True, "concurrent_prepare_requests": 8})
        print("PASS after-PUT SIGKILL, real lease takeover, fresh generation/CAS and original invariance", flush=True)
        stop(root, env, "safety-worker")
        path, file, snapshot = create("unknown-commit")
        generation = prepare(path)
        proxy.control.update(mode="unknown_commit", discard=False)
        worker_log_offset = (root / "safety-worker.log").stat().st_size
        spawn(root, env, "safety-worker", worker_config)
        assert proxy.committed.wait(50)
        assert any(event.get("event") == "suppressed_command_complete" and event.get("tag") == "UPDATE 1" for event in proxy.events)
        eventually(lambda: any(event["event"] == "authoritative_load_after_lost_commit_ack" for event in proxy.events))
        eventually(lambda: row(generation)["state"] == "ready")
        time.sleep(3)
        assert row(generation)["state"] == "ready" and row(generation)["is_current"]
        status = api.json("GET", path + "/preview/geodata")
        assert status["generation"] == generation and api.call("GET", status["result_url"])[1] == kmz
        unchanged(path, file, snapshot)
        ciphertext = h.s3_request(root, env, "GET", row(generation)["output_object_key"])
        assert ciphertext != kmz
        assert b"device preview attempt failed" not in (root / "safety-worker.log").read_bytes()[worker_log_offset:]
        evidence["cases"].append({"case": "committed_publish_ack_lost", "generation": generation, "state": "ready", "authoritative_worker_read_observed": True, "no_attempt_failure": True, "result_read_sha256": hashlib.sha256(kmz).hexdigest(), "original_unchanged": True, "converter_version": row(generation)["converter_version"]})
        print("PASS actual committed UPDATE with suppressed CommandComplete/ReadyForQuery and worker authoritative ready recovery", flush=True)
        uploads_before_restart = len(mock_events)
        stop(root, env, "safety-worker", force=True)
        spawn(root, env, "safety-worker", worker_config)
        assert api.json("POST", path + "/preview/geodata")["generation"] == generation
        time.sleep(6)
        assert len(mock_events) == uploads_before_restart
        unchanged(path, file, snapshot)
        evidence["cases"].append({"case": "after_cas_process_kill_ready_reuse", "generation": generation, "new_converter_uploads": 0, "original_unchanged": True})
        print("PASS after-CAS process kill/restart reuses ready without conversion", flush=True)
        stop(root, env, "safety-worker")
        status = api.json("GET", path + "/preview/geodata")
        api.call("HEAD", status["result_url"])
        s3_control["hold_key"] = row(generation)["output_object_key"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(api.call, "GET", status["result_url"], expected=403)
            assert read_held.wait(10)
            try:
                h.sql(root, env, f"update login set roles='[]'::jsonb where login='{actor['login']}'", env["main_db"])
                read_release.set()
                _, denied = pending.result(timeout=20)
                assert kmz not in denied
            finally:
                read_release.set()
                h.sql(root, env, f"update login set roles='[\"Admin\",\"Api\",\"Cyber\"]'::jsonb where login='{actor['login']}'", env["main_db"])
        s3_control["hold_key"] = None
        unchanged(path, file, snapshot)
        evidence["cases"].append({"case": "real_result_read_revoked_after_head_during_storage_read", "generation": generation, "head_status_before_revocation": 200, "get_status_after_revocation": 403, "bytes_not_released": True})
        print("PASS result HEAD then actual delayed storage-read revocation returns403 without KMZ bytes", flush=True)
        path, file, snapshot = create("deleted-after-put")
        generation = prepare(path)
        proxy.blocked.clear()
        proxy.release.clear()
        proxy.control.update(mode="block", discard=False)
        spawn(root, env, "safety-worker", worker_config)
        assert proxy.blocked.wait(50)
        deleted_row = row(generation)
        deleted_ciphertext = h.s3_request(root, env, "GET", deleted_row["output_object_key"])
        assert deleted_ciphertext and deleted_row["state"] == "running"
        sql(f"begin; update file_entry set content_path=null where id='{file['file_id']}'; alter table file_content disable trigger file_content_immutable_trg; delete from file_content where file_id='{file['file_id']}' and revision={file['revision']}; alter table file_content enable trigger file_content_immutable_trg; commit;")
        assert row(generation)["source_file_id"] is None
        proxy.control["mode"] = "normal"
        proxy.release.set()
        read_release.set()
        eventually(lambda: len([event for event in proxy.events if event.get("event") == "forwarded_command_complete" and event.get("tag") == "UPDATE 0"]) > 0)
        assert row(generation)["state"] != "ready"
        for method, suffix in [("GET", "/content"), ("HEAD", "/content"), ("GET", "/preview/geodata"), ("POST", "/preview/geodata"), ("GET", f"/preview/geodata/{generation}/content"), ("HEAD", f"/preview/geodata/{generation}/content")]:
            api.call(method, path + suffix, expected=404)
        evidence["cases"].append({"case": "source_deleted_after_put_publish_cas_zero", "generation": generation, "ciphertext_size": len(deleted_ciphertext), "source_fk_null": True, "ready_not_published": True, "http_denials": 6})
        print("PASS source deletion after real PUT, publish CAS UPDATE0, denied result/status/original", flush=True)
        stop(root, env, "safety-worker")
        # Ninety-five-minute cleanup grace is explicit test-time acceleration;
        # the crash/takeover above uses the real 120-second persisted lease.
        sql(f"update file_preview set attempt_deadline=now()-interval '2 hours',lease_until=now()-interval '1 second',cleanup_after=now()-interval '1 second' where generation='{generation}'")
        s3_control["fail_delete"] = True
        spawn(root, env, "safety-worker", worker_config)
        eventually(lambda: bool(s3_events), 70)
        eventually(lambda: sql(f"select cleanup_after>now() from file_preview where generation='{generation}'") == "t", 70)
        assert row(generation)["object_deleted_at"] is None
        eventually(lambda: row(generation)["state"] == "failed")
        assert row(generation)["is_current"]
        assert h.s3_request(root, env, "GET", deleted_row["output_object_key"]) == deleted_ciphertext
        stop(root, env, "safety-worker")
        s3_control["fail_delete"] = False
        sql(f"update file_preview set cleanup_after=now()-interval '1 second' where generation in ('{old}','{generation}')")
        spawn(root, env, "safety-worker", worker_config)
        eventually(lambda: all(row(candidate)["object_deleted_at"] is not None for candidate in (old, generation)), 40)
        tombstone = row(generation)["tombstone_until"]
        for key in (old_row["output_object_key"], deleted_row["output_object_key"]):
            try:
                h.s3_request(root, env, "GET", key)
            except urllib.error.HTTPError as error:
                assert error.code == 404
            else:
                raise AssertionError("retired/deleted-source derivative survived cleanup")
        stop(root, env, "safety-worker")
        h.s3_request(root, env, "PUT", deleted_row["output_object_key"], deleted_ciphertext)
        sql(f"update file_preview set cleanup_after=now()-interval '1 second' where generation='{generation}'")
        spawn(root, env, "safety-worker", worker_config)
        eventually(lambda: len([event for event in s3_events if event["status"] == 204 and event["path"].endswith(deleted_row["output_object_key"])]) >= 2, 40)
        assert row(generation)["tombstone_until"] == tombstone
        evidence["cases"].append({"case": "real_s3_delete_retry_and_late_put_tombstone", "generation": generation, "current_failed_preserved": True, "failed_delete_object_retained": True, "successful_delete_verified_404": True, "late_put_deleted_again": True, "tombstone_deadline_unchanged": True})
        print("PASS actual DELETE503 retry, verified private-S3 removal and late-PUT re-delete with preserved tombstone", flush=True)
    finally:
        stop(root, env, "safety-worker")
        stop(root, env, "safety-api")
        evidence["postgres_proxy_events"] = proxy.events
        evidence["mock_events"] = mock_events
        evidence["s3_delete_events"] = s3_events
        evidence["limitations"] = ["No live Alpine conversion or authentic nine-format support claim.", "Cleanup timing faults explicitly accelerate only dedicated test-ledger timestamps."]
        h.private_write(root / "backend-safety-fault-proof.json", json.dumps(evidence, indent=2) + "\n")
        proxy.release.set()
        proxy.shutdown()
        mock.shutdown()
        s3_proxy.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--role", choices=("safety-api", "safety-worker"))
    parser.add_argument("--mutation-test-binary")
    args = parser.parse_args()
    os.umask(0o077)
    root, env = h.load(args.root)
    if args.mutation_test_binary:
        qualify_mutation(root, env, args.mutation_test_binary)
        sys.exit(0)
    if args.role:
        binary = str(h.REPO / "target/debug/wdintel-rs")
        runtime = dict(os.environ)
        runtime["TMPDIR"] = str(root / "cache-a")
        if args.role == "safety-api":
            listener = socket.socket()
            listener.bind(("127.0.0.1", env["api_a_port"]))
            listener.listen(128)
            os.dup2(listener.fileno(), 3)
            os.set_inheritable(3, True)
            runtime.update(LISTEN_PID=str(os.getpid()), LISTEN_FDS="1")
            command = ["--mode=debug", "server", "--no-bgworker"]
        else:
            command = ["--mode=debug", "bgworker"]
        os.execve(binary, [binary, *command], runtime)
    try:
        main(root, env)
    finally:
        stop(root, env, "safety-worker")
        stop(root, env, "safety-api")
