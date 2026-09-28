#!/usr/bin/env python3
import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time

import stage

from migration_common import (
    BACKUP_DATASET, BACKUP_PATH, GIB, HOLD, LOCAL_LOCK, ROOT, RUN, SNAPSHOT, STATE, SafetyStop,
    assert_guest_absent, check_pause, config_values, event, exists, health,
    load_manifest, notify, now, output, prop, protect_args, remote, ssh_args,
    target_config, write_json, zfs,
)
from stage import pump, rsync_command, stop_children

DIRECTORY = STATE / "cutover"


def read_state(ident):
    path = DIRECTORY / f"{ident}.json"
    return json.loads(path.read_text()) if path.exists() else {
        "id": ident, "phase": "base_verified", "common": SNAPSHOT,
    }


def save(ident, **updates):
    with LOCAL_LOCK:
        state = read_state(ident)
        state.update(updates, updated=now())
        write_json(DIRECTORY / f"{ident}.json", state)
        render()
        return state


def render():
    lines = ["# Cutover status", "", f"Updated: {now()}", "",
             "Source autostart is disabled before shutdown. Target autostart is enabled after validation.",
             "", "| Guest | Target | Phase | Last update UTC |",
             "| --- | --- | --- | --- |"]
    for guest in load_manifest()["guests"]:
        state = read_state(guest["id"])
        lines.append(f"| {guest['id']} {guest['name']} | {guest['target']} | "
                     f"{state['phase']} | {state.get('updated', '')} |")
    path = ROOT / f"CUTOVER.md.{os.getpid()}.tmp"
    path.write_text("\n".join(lines) + "\n")
    path.replace(ROOT / "CUTOVER.md")


def command(guest):
    return "pct" if guest["kind"] == "lxc" else "qm"


def config(guest, host):
    return output(host, "sudo", "-n", command(guest), "config", guest["id"], "--current", "1")


def require_status(guest, host, expected):
    actual = output(host, "sudo", "-n", command(guest), "status", guest["id"])
    if actual != f"status: {expected}":
        raise SafetyStop(f"Guest {guest['id']} on {host}: expected {expected}, got {actual}")


def check_config(guest):
    current = config(guest, guest["source"])
    original = (STATE / "configs" / f"{guest['id']}.target.conf").read_text()
    if target_config(current, guest["kind"]).strip() != original.strip():
        raise SafetyStop(f"Guest {guest['id']} configuration changed since preparation")
    if config_values(current).get("lock"):
        raise SafetyStop(f"Guest {guest['id']} is locked")
    return current


def protected(guest):
    host, dataset = guest["target"], guest["dataset"]
    expected = {"echo:migration": RUN, "readonly": "on"}
    expected.update({"mounted": "no", "canmount": "noauto"} if guest["kind"] == "lxc"
                    else {"volmode": "none", "refreservation": "0"})
    for key, value in expected.items():
        if prop(host, dataset, key) != value:
            raise SafetyStop(f"Unprotected destination {guest['id']}: {key}")
    assert_guest_absent(guest)


def same_snapshot(guest, snapshot):
    path = f"{guest['dataset']}@{snapshot}"
    source_guid = prop(guest["source"], path, "guid")
    if source_guid != prop(guest["target"], path, "guid"):
        raise SafetyStop(f"Snapshot GUID mismatch for {guest['id']} {snapshot}")
    return source_guid


def hold(host, path):
    if not any(line.split()[1] == HOLD for line in zfs(host, "holds", "-H", path).splitlines()):
        zfs(host, "hold", HOLD, path)


def estimate(guest, previous, snapshot):
    dataset = guest["dataset"]
    result = zfs(guest["source"], "send", "-nPLcp", "-i", f"{dataset}@{previous}",
                 f"{dataset}@{snapshot}")
    return int(next(line.split()[1] for line in result.splitlines() if line.startswith("size\t")))


def snapshot(guest, label):
    name = f"echo-hz-migrate-{RUN}-{label}-{time.time_ns()}"
    path = f"{guest['dataset']}@{name}"
    zfs(guest["source"], "snapshot", path)
    hold(guest["source"], path)
    return name


def transfer_guard(guest):
    check_pause()
    health(guest["source"])
    health(guest["target"])
    require_status(guest, guest["source"], read_state(guest["id"]).get("expected_source", "running"))
    assert_guest_absent(guest)


def report(ident, phase, bytes_sent):
    save(ident, bytes_sent=bytes_sent)


def send(guest, previous, snapshot_name):
    protected(guest)
    same_snapshot(guest, previous)
    path = f"{guest['dataset']}@{snapshot_name}"
    if exists(guest["target"], path):
        same_snapshot(guest, snapshot_name)
        return
    token = prop(guest["target"], guest["dataset"], "receive_resume_token")
    args = ["-Lcp", "-i", f"{guest['dataset']}@{previous}", path]
    if token != "-":
        details = zfs(guest["source"], "send", "-nPv", "-t", token)
        names = re.findall(r"^\s*toname = (.+)$", details, re.MULTILINE)
        guids = re.findall(r"^\s*toguid = (0x[0-9a-fA-F]+)$", details, re.MULTILINE)
        if names != [path] or len(guids) != 1 or str(int(guids[0], 16)) != prop(guest["source"], path, "guid"):
            raise SafetyStop("Incremental resume token does not match requested snapshot")
        args = ["-t", token]
    log_path = STATE / "logs" / f"{guest['id']}.incremental.log"
    with log_path.open("ab") as log:
        children = []
        try:
            receiver = subprocess.Popen(ssh_args(guest["target"], ["sudo", "-n", "zfs", "receive",
                "-s", "-u", *protect_args(guest), guest["dataset"]]), stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL, stderr=log)
            children.append(receiver)
            sender = subprocess.Popen(ssh_args(guest["source"], ["sudo", "-n", "zfs", "send", *args]),
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=log)
            children.append(sender)
            total = pump(sender, receiver, guest, read_state(guest["id"]).get("bytes_sent", 0),
                         transfer_guard, report)
            save(guest["id"], bytes_sent=total)
        finally:
            stop_children(children)
    same_snapshot(guest, snapshot_name)
    if prop(guest["target"], guest["dataset"], "receive_resume_token") != "-":
        raise SafetyStop("Incremental receive remains incomplete")
    hold(guest["target"], path)


def warm(guest):
    ident = guest["id"]
    state = read_state(ident)
    if state["phase"] not in ("base_verified", "warm_copying", "warm_verified"):
        raise SafetyStop(f"Cannot warm-sync {ident} in phase {state['phase']}")
    check_config(guest)
    transfer_guard(guest)
    protected(guest)
    same_snapshot(guest, state["common"])
    pending = state.get("pending") or snapshot(guest, "warm")
    size = estimate(guest, state["common"], pending)
    health(guest["target"], size)
    prior = state.get("bytes_sent", 0) if state.get("pending") else 0
    save(ident, phase="warm_copying", pending=pending, expected_source="running",
         estimate_bytes=size, bytes_sent=prior)
    event(f"Guest {ident}: warm incremental {size / GIB:.3f} GiB; source remains running.")
    send(guest, state["common"], pending)
    save(ident, phase="warm_verified", common=pending, pending=None)
    event(f"Guest {ident}: warm incremental verified.")


def stop_source(guest):
    ident = guest["id"]
    check_config(guest)
    transfer_guard(guest)
    protected(guest)
    state = read_state(ident)
    same_snapshot(guest, state["common"])
    changed = int(prop(guest["source"], guest["dataset"], f"written@{state['common']}"))
    if changed > GIB:
        raise SafetyStop(f"Guest {ident} needs another warm sync before shutdown")
    for host in (guest["source"], guest["target"]):
        resources = json.loads(output(host, "sudo", "-n", "pvesh", "get", "/cluster/ha/resources",
                                      "--output-format", "json"))
        if any(str(r.get("sid", "")).split(":")[-1] == str(ident) for r in resources):
            raise SafetyStop(f"Guest {ident} is managed by HA")
    current = config(guest, guest["source"])
    path = DIRECTORY / f"{ident}.source-before-cutover.conf"
    path.write_text(current)
    os.chmod(path, 0o600)
    save(ident, phase="shutting_down", outage_started=now(), outage_epoch=time.time())
    output(guest["source"], "sudo", "-n", command(guest), "set", ident, "--onboot", "0")
    if ident == 128:
        output(guest["source"], "sudo", "-n", "pct", "exec", ident, "--", "systemctl", "stop",
               "echo-vllm-router", "echo-vllm-router@nuextract", "echo-vllm-router@ocr-gemma")
        event("Guest 128: router services stopped before guest networking, allowing their graceful shutdown.")
    output(guest["source"], "sudo", "-n", command(guest), "shutdown", ident, "--timeout", "90")
    require_status(guest, guest["source"], "stopped")
    output(guest["source"], "sudo", "-n", command(guest), "set", ident, "--lock", "migrate")
    save(ident, phase="source_stopped", expected_source="stopped", source_onboot=0)
    event(f"Guest {ident}: source stopped gracefully, onboot=0, migration lock applied.")


def final_sync(guest):
    ident = guest["id"]
    state = read_state(ident)
    require_status(guest, guest["source"], "stopped")
    final = state.get("pending") or snapshot(guest, "final")
    size = estimate(guest, state["common"], final)
    health(guest["target"], size)
    save(ident, phase="final_copying", pending=final, estimate_bytes=size, bytes_sent=0)
    event(f"Guest {ident}: final incremental {size / GIB:.3f} GiB.")
    send(guest, state["common"], final)
    save(ident, phase="final_verified", common=final, pending=None, final_snapshot=final)


def sync_bind(guest):
    if guest["id"] != 420 or prop(guest["target"], BACKUP_DATASET, "echo:migration") != RUN:
        raise SafetyStop("Unexpected bind mount owner")
    require_status(guest, guest["source"], "stopped")
    local = STATE / "backup-data"
    if not local.is_dir() or local.is_symlink():
        raise SafetyStop("Bind staging directory is missing or unsafe")
    zfs(guest["target"], "set", "readonly=off", "canmount=on", BACKUP_DATASET)
    if prop(guest["target"], BACKUP_DATASET, "mounted") != "yes":
        zfs(guest["target"], "mount", BACKUP_DATASET)
    pairs = [(f"{guest['source']}:{BACKUP_PATH}/", f"{local}/"),
             (f"{local}/", f"{guest['target']}:{BACKUP_PATH}/")]
    with (STATE / "logs" / "420.final-bind.log").open("ab") as log:
        for source, target in pairs:
            args = rsync_command(source, target)
            args[args.index("--stats"):args.index("--stats") + 1] = ["--checksum", "--delete-delay"]
            subprocess.run(args, stdout=log, stderr=log, check=True, timeout=240)
            audit = subprocess.run(args[:-2] + ["--dry-run", "--itemize-changes", "--out-format=%i",
                                               *args[-2:]], capture_output=True, text=True, check=True, timeout=180)
            if audit.stdout.strip():
                raise SafetyStop("CT 420 checksum audit still finds changed files")
    name = read_state(420)["final_snapshot"]
    zfs(guest["target"], "snapshot", f"{BACKUP_DATASET}@{name}")
    hold(guest["target"], f"{BACKUP_DATASET}@{name}")
    save(420, bind_final_verified=True)
    event("Guest 420: final /backup copy and checksum/metadata comparisons verified at both hops.")


def fix_vault_boot(guest):
    mount = prop(guest["target"], guest["dataset"], "mountpoint")
    script = r'''
import os, sys
from pathlib import Path
root = Path(sys.argv[1])
script = root / 'usr/local/bin/vault-auto-unseal.sh'
data = script.read_text()
old = 'VAULT_ADDR="https://oblik-os-cloud-vault.tawny-prometheus.ts.net:8200"'
if old not in data:
    raise SystemExit('Unexpected Vault unseal script; refusing replacement')
data = data.replace(old, 'VAULT_ADDR="https://127.0.0.1:8200"\nexport VAULT_TLS_SERVER_NAME="oblik-os-cloud-vault.tawny-prometheus.ts.net"')
data = data.replace('curl -sS --connect-timeout 1 "${VAULT_ADDR}/v1/sys/health"',
    'curl -sS --connect-timeout 1 --max-time 3 --resolve "${VAULT_TLS_SERVER_NAME}:8200:127.0.0.1" "https://${VAULT_TLS_SERVER_NAME}:8200/v1/sys/health"')
script.write_text(data)
directory = root / 'etc/systemd/system/vault-auto-unseal.service.d'
directory.mkdir(exist_ok=True)
override = directory / 'migration-startup.conf'
override.write_text('[Unit]\nAfter=vault.service\nStartLimitIntervalSec=0\n\n[Service]\nTimeoutStartSec=300\nRestart=on-failure\nRestartSec=5\n')
os.chmod(override, 0o644)
'''
    remote(guest["target"], "sudo", "-n", "python3", "-", mount, input=script)
    save(647, unseal_boot_fix=True)
    event("Guest 647: destination-only unseal readiness now uses loopback with verified TLS hostname; retry/timeout override installed. Keys were not logged.")


def boot_target(guest):
    ident = guest["id"]
    require_status(guest, guest["source"], "stopped")
    values = config_values(config(guest, guest["source"]))
    if values.get("onboot") != "0" or values.get("lock") != "migrate":
        raise SafetyStop("Source must be stopped with autostart disabled and migration lock set")
    protected(guest)
    state = read_state(ident)
    same_snapshot(guest, state["final_snapshot"])
    if time.time() - state["outage_epoch"] > 10 * 60:
        raise SafetyStop("More than ten minutes elapsed before destination boot; operator recovery required")
    health(guest["target"])
    folder = "lxc" if guest["kind"] == "lxc" else "qemu-server"
    path = f"/etc/pve/{folder}/{ident}.conf"
    text = target_config(config(guest, guest["source"]), guest["kind"])
    if guest["kind"] == "lxc" and "nameserver" not in config_values(text):
        text += "nameserver: 8.8.8.8 1.1.1.1\n"
    remote(guest["target"], "sudo", "-n", "python3", "-c",
           "import sys; p=sys.argv[1]; data=sys.stdin.read(); f=open(p,'x'); f.write(data); f.close()",
           path, input=text)
    save(ident, phase="target_registered", target_onboot=0)
    if guest["kind"] == "lxc":
        zfs(guest["target"], "set", "readonly=off", "canmount=on", guest["dataset"])
        if prop(guest["target"], guest["dataset"], "mounted") != "yes":
            zfs(guest["target"], "mount", guest["dataset"])
    else:
        zfs(guest["target"], "set", "readonly=off", "volmode=dev", guest["dataset"])
    if ident == 647:
        fix_vault_boot(guest)
    require_status(guest, guest["source"], "stopped")
    save(ident, phase="target_starting", target_may_have_written=True)
    output(guest["target"], "sudo", "-n", command(guest), "start", ident)
    require_status(guest, guest["target"], "running")
    save(ident, phase="awaiting_validation", booted=now())
    event(f"Guest {ident}: started on {guest['target']}; source remains stopped/locked; validating applications.")


def switch(guest):
    state = read_state(guest["id"])
    if state["phase"] != "warm_verified":
        raise SafetyStop("A verified warm incremental is required")
    stop_source(guest)
    final_sync(guest)
    if guest["id"] == 420:
        sync_bind(guest)
    boot_target(guest)


def confirm(guest):
    ident = guest["id"]
    state = read_state(ident)
    if state["phase"] != "awaiting_validation":
        raise SafetyStop("Guest must be booted and validated before confirmation")
    if not state.get("validation_checks"):
        raise SafetyStop("Application validation evidence must be recorded before confirmation")
    require_status(guest, guest["source"], "stopped")
    require_status(guest, guest["target"], "running")
    if config_values(config(guest, guest["source"])).get("onboot") != "0":
        raise SafetyStop("Source autostart is not disabled")
    health(guest["target"])
    output(guest["target"], "sudo", "-n", command(guest), "set", ident, "--onboot", "1")
    if config_values(config(guest, guest["target"])).get("onboot") != "1":
        raise SafetyStop("Destination autostart was not enabled")
    elapsed = round(time.time() - state["outage_epoch"])
    save(ident, phase="migrated", validated=now(), target_onboot=1, validation_elapsed_seconds=elapsed)
    for location in ("source", "target"):
        path = DIRECTORY / f"{ident}.{location}-final.conf"
        path.write_text(config(guest, guest[location]))
        os.chmod(path, 0o600)
    message = (f"Migrated {ident} {guest['name']} to {guest['target']}; application/network checks passed. "
               f"Source stopped, locked and onboot=0; destination running with onboot=1. "
               f"Shutdown-to-validation elapsed {elapsed // 60}m {elapsed % 60}s. Source copies and final snapshots retained.")
    event(message)
    notify(message, f"migrated-{ident}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("warm", "switch", "confirm", "status"))
    parser.add_argument("ids", nargs="*", type=int)
    parser.add_argument("--rate-mib", type=int, default=5)
    args = parser.parse_args()
    if not 1 <= args.rate_mib <= 10:
        raise SafetyStop("Transfer limit must be between 1 and 10 MiB/s")
    stage.RATE = args.rate_mib * 1024 * 1024
    DIRECTORY.mkdir(mode=0o700, exist_ok=True)
    manifest = {g["id"]: g for g in load_manifest()["guests"]}
    if args.action == "status":
        render()
        print((ROOT / "CUTOVER.md").read_text())
        return
    if not args.ids or any(ident not in manifest for ident in args.ids):
        raise SafetyStop("Explicit allowlisted guest IDs are required")
    for ident in args.ids:
        with (DIRECTORY / f"{ident}.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                {"warm": warm, "switch": switch, "confirm": confirm}[args.action](manifest[ident])
            except Exception as exc:
                event(f"Guest {ident}: cutover operation stopped ({type(exc).__name__}); inspect private logs/state.")
                notify(f"Hetzner migration {ident} needs attention during {args.action}: {type(exc).__name__}. "
                       "Cutover stopped; source/target state is recorded in the archive.", f"cutover-error-{ident}-{now()}")
                raise


if __name__ == "__main__":
    main()
