#!/usr/bin/env python3
"""Private device-audio browser/backend environment (Python 3.11+)."""

import argparse
import contextlib
import io
import json
import os
import secrets
import shlex

import file_preview_harness as shared


def load(root):
    root, environment = shared.load(root, "device-audio")
    ports = [value for key, value in environment.items() if key.endswith("_port")]
    shared.require(len(ports) == 8 and len(ports) == len(set(ports)) and
                   all(isinstance(port, int) and 1024 < port < 65536 for port in ports),
                   "Audio fixture ports must be distinct unprivileged ports")
    shared.private_file(root / "asr-token")
    return root, environment


def prepare():
    for dependency in ("ffmpeg", "ffprobe"):
        shared.require(shared.shutil.which(dependency), f"Missing test prerequisite: {dependency}")
    with contextlib.redirect_stdout(io.StringIO()):
        root, environment = shared.prepare("device-audio")
    occupied = {value for key, value in environment.items() if key.endswith("_port")}
    ports = [port for port in shared.fresh_ports() if port not in occupied]
    shared.require(len(ports) >= 2, "Could not reserve separate ASR ports; prepare a new run")
    environment.update(asr_rs_port=ports[0], asr_py_port=ports[1])
    shared.private_write(root / "asr-token", secrets.token_urlsafe(32))
    values = {"AUDIO_TEST_ROOT": str(root), "AUDIO_TEST_RUN": environment["run"],
              "AUDIO_S3_BUCKET": environment["bucket"],
              "AUDIO_S3_ENDPOINT": f"http://127.0.0.1:{environment['s3_port']}",
              "AUDIO_STORAGE_DIR": str(root / "storage-a"),
              "AUDIO_ASR_RS_URL": f"http://127.0.0.1:{environment['asr_rs_port']}",
              "AUDIO_ASR_PY_URL": f"http://127.0.0.1:{environment['asr_py_port']}"}
    shared.private_write(root / "environment.sh", (root / "environment.sh").read_text() +
                         "".join(f"export {key}={shlex.quote(value)}\n" for key, value in values.items()))
    shared.save(root, environment)
    load(root)
    print(root)
    return root, environment


def seed_actors(root, environment):
    fixtures = json.loads((root / "fixtures-private.json").read_text())
    if fixtures["actors"]:
        return
    query = lambda statement: shared.sql(root, environment, statement, environment["main_db"])
    query("UPDATE system_settings SET devices_section_enabled=true,enable_audio_transcription=false;")
    run = environment["run"]
    roles = '["Admin","Api","Cyber","CyberViewer"]'
    zone = query(f"INSERT INTO sigint_zone(name) VALUES('audio-{run}') RETURNING id;")
    parent = query(f"INSERT INTO organism(name,roles,enabled) VALUES('audio-parent-{run}','{roles}'::jsonb,true) RETURNING id;")
    child = query(f"INSERT INTO organism(name,roles,enabled,parent_id) VALUES('audio-child-{run}','{roles}'::jsonb,true,{parent}) RETURNING id;")
    foreign = query(f"INSERT INTO organism(name,roles,enabled) VALUES('audio-foreign-{run}','{roles}'::jsonb,true) RETURNING id;")
    for key, role, organism in (("api-source", "Cyber", child),
                               ("parent-cyberviewer", "CyberViewer", parent),
                               ("parent-cyber", "Cyber", parent),
                               ("parent-admin", "Admin", parent),
                               ("foreign-cyber", "Cyber", foreign)):
        login, password = f"{key}-{run}", secrets.token_urlsafe(24)
        shared.command([str(shared.REPO / "target/debug/wdintel-rs"), "--mode=test", "oneoff-register-user",
                        "--login", login, "--password", password, "--role", role, "--sigint-zone", zone,
                        "--organism-id", organism], root, shared.runtime_env(root, environment))
        actor_roles = [role, "Api"]
        query(f"UPDATE login SET roles='{json.dumps(actor_roles)}'::jsonb WHERE login='{login}';")
        fixtures["actors"][key] = {"login": login, "password": password, "roles": actor_roles}
    query("UPDATE gpu_config SET is_active=false;")
    query(f"INSERT INTO gpu_config(id,name,host,is_active,rs_port,py_port,train,ordering) "
          f"VALUES(gen_random_uuid(),'audio-fixture-{run}','127.0.0.1',true,"
          f"{environment['asr_rs_port']},{environment['asr_py_port']},false,1) "
          "ON CONFLICT(host) DO UPDATE SET name=EXCLUDED.name,is_active=true,"
          "rs_port=EXCLUDED.rs_port,py_port=EXCLUDED.py_port,train=false;")
    shared.private_write(root / "fixtures-private.json", json.dumps(fixtures, indent=2))


def start(root, environment):
    shared.require(environment["stage"] == "prepared", "Start requires a fresh prepared run; stop incomplete runs first")
    shared.require((shared.REPO / "wdintel-web/node_modules/.bin/elm-land").is_file(), "Run npm ci in wdintel-web first")
    environment["stage"] = "starting"
    shared.save(root, environment)
    shared.start_storage(root, environment)
    shared.restore_databases(root, environment)
    shared.command(["just", "migrate-all-up", "test"], root, shared.runtime_env(root, environment))
    shared.command(["cargo", "build", "--locked", "-p", "wdintel-rs"], root, shared.runtime_env(root, environment))
    seed_actors(root, environment)
    shared.spawn(root, environment, "asr")
    for port in ("asr_rs_port", "asr_py_port"):
        shared.wait_url(f"http://127.0.0.1:{environment[port]}/")
    shared.spawn(root, environment, "redis")
    for role in ("a", "b"):
        shared.spawn(root, environment, f"api-{role}")
        shared.wait_url(f"http://127.0.0.1:{environment[f'api_{role}_port']}/api/ping", 120)
    shared.spawn(root, environment, "front")
    shared.wait_url(f"http://127.0.0.1:{environment['front_port']}", 120)
    shared.spawn(root, environment, "proxy")
    shared.wait_url(f"http://127.0.0.1:{environment['proxy_port']}/api/ping")
    environment["stage"] = "ready"
    shared.save(root, environment)
    print("Ready; source", root / "environment.sh")


def run_role(root, environment, role):
    if role != "asr":
        shared.run_role(root, environment, role)
        return
    from device_audio_asr_fixture import serve
    serve(environment["asr_rs_port"], environment["asr_py_port"], (root / "asr-token").read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "start", "stop", "run-role"))
    parser.add_argument("--root")
    parser.add_argument("--role", choices=("asr", "redis", "api-a", "api-b", "front", "proxy"))
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "prepare":
        prepare()
        return
    shared.require(args.root, "Supply this run's --root; no shared default is accepted")
    root, environment = load(args.root)
    if args.command == "start":
        start(root, environment)
    elif args.command == "stop":
        shared.teardown(root, environment)
    else:
        shared.require(args.role, "Supply --role")
        run_role(root, environment, args.role)


if __name__ == "__main__":
    main()
