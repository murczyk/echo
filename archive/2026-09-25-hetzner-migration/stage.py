#!/usr/bin/env python3
import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import select
import shlex
import signal
import subprocess
import sys
import time

from migration_common import (
    BACKUP_DATASET, BACKUP_PATH, GIB, HOLD, HOSTS, RATE, REMOTE_STATE, ROOT,
    RUN, SNAPSHOT, SSH_OPTIONS, STATE, SafetyStop, assert_guest_absent,
    check_pause, config_values, event, exists, guests, health, load_manifest,
    notify, now, output, progress, prop, protect_args, remote, render_status,
    ssh_args, target_config, verify_received, write_json, zfs,
)


def ensure_state():
    STATE.mkdir(mode=0o700, exist_ok=True)
    os.chmod(STATE, 0o700)
    for name in ("configs", "logs", "progress"):
        (STATE / name).mkdir(mode=0o700, exist_ok=True)


def assert_source_running(guest):
    command = "pct" if guest["kind"] == "lxc" else "qm"
    status = output(guest["source"], "sudo", "-n", command, "status", str(guest["id"]))
    if status != "status: running":
        raise SafetyStop(f"Source guest {guest['id']} is not running")


def capture_guest(guest):
    command = "pct" if guest["kind"] == "lxc" else "qm"
    source, ident = guest["source"], str(guest["id"])
    config = output(source, "sudo", "-n", command, "config", ident, "--current", "1")
    values = config_values(config)
    disk = values.get("rootfs" if guest["kind"] == "lxc" else "scsi0", "").split(",")[0]
    expected_disk = f"local-zfs:{guest['dataset'].split('/')[-1]}"
    if values.get("hostname", values.get("name")) != guest["name"] or disk != expected_disk:
        raise SafetyStop(f"Source config identity/disk mismatch for {ident}")
    extra = [key for key in values if key.startswith(("mp", "unused", "hostpci", "efidisk", "tpmstate"))]
    if extra != (["mp0"] if guest["id"] == 420 else []):
        raise SafetyStop(f"Uninventoried storage/devices for {ident}: {extra}")
    if guest["kind"] == "qemu":
        drives = {key for key in values if re.fullmatch(r"(scsi|virtio|sata|ide)\d+", key)}
        if drives != {"scsi0", "ide2"} or "media=cdrom" not in values["ide2"]:
            raise SafetyStop(f"Uninventoried VM drives for {ident}: {drives}")
    if guest["kind"] == "lxc":
        mounts = [line for line in config.splitlines() if line.startswith("lxc.mount.entry:")]
        if mounts != ["lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file"]:
            raise SafetyStop(f"Uninventoried LXC host mount for {ident}")
    if guest["id"] == 420 and values["mp0"] != f"{BACKUP_PATH},mp=/backup,backup=0":
        raise SafetyStop("CT 420 bind mount changed")
    if prop(source, guest["dataset"], "encryption") != "off":
        raise SafetyStop(f"Encrypted source dataset requires a separate plan: {ident}")
    if len(zfs(source, "list", "-Hr", "-o", "name", guest["dataset"]).splitlines()) != 1:
        raise SafetyStop(f"Unexpected child datasets for {ident}")
    assert_source_running(guest)
    assert_guest_absent(guest)
    save_configs(guest, config)
    guest.update(config_sha256=hashlib.sha256(config.encode()).hexdigest(),
                 original_onboot=values.get("onboot", "0"),
                 mac=next(part.split("=", 1)[1] for part in values["net0"].split(",")
                          if part.startswith(("hwaddr=", "virtio="))),
                 referenced_bytes=int(prop(source, guest["dataset"], "referenced")))
    return guest


def save_configs(guest, config):
    ident = str(guest["id"])
    folder = "lxc" if guest["kind"] == "lxc" else "qemu-server"
    raw = output(guest["source"], "sudo", "-n", "cat", f"/etc/pve/{folder}/{ident}.conf")
    for suffix, contents in (
        ("source.conf", raw), ("current.conf", config),
        ("target.conf", target_config(config, guest["kind"])),
    ):
        path = STATE / "configs" / f"{ident}.{suffix}"
        path.write_text(contents + "\n")
        os.chmod(path, 0o600)


def stage_configs(guest):
    host = guest["target"]
    directory = f"{REMOTE_STATE}/configs"
    remote(host, "sudo", "-n", "install", "-d", "-m", "0700", directory)
    remote(host, "sudo", "-n", "tee", f"{directory}/{guest['id']}.conf",
           input=(STATE / "configs" / f"{guest['id']}.target.conf").read_text())
    remote(host, "sudo", "-n", "chmod", "0600", f"{directory}/{guest['id']}.conf")


def capture_snapshot(guest):
    source, dataset = guest["source"], guest["dataset"]
    snapshot = f"{dataset}@{SNAPSHOT}"
    if not exists(source, snapshot):
        zfs(source, "snapshot", snapshot)
    holds = zfs(source, "holds", "-H", snapshot)
    if not any(line.split()[1] == HOLD for line in holds.splitlines()):
        zfs(source, "hold", HOLD, snapshot)
    guest["snapshot_guid"] = prop(source, snapshot, "guid")
    guest["snapshot_created"] = int(prop(source, snapshot, "creation"))
    estimate = zfs(source, "send", "-nPLcp", snapshot)
    guest["stream_bytes"] = int(next(line.split()[1] for line in estimate.splitlines()
                                     if line.startswith("size\t")))
    event(f"Guest {guest['id']}: base snapshot held; stream estimate "
          f"{guest['stream_bytes'] / GIB:.2f} GiB; source remains running.")


def prepare():
    if (ROOT / "manifest.json").exists():
        load_manifest()
        print("Manifest already prepared; use seed to continue.")
        return
    selected = [capture_guest(guest) for guest in guests()]
    baseline = {host: health(host) for host in HOSTS}
    for guest in selected:
        if exists(guest["target"], guest["dataset"]):
            raise SafetyStop(f"Destination dataset already exists: {guest['dataset']}")
    if exists("pve-hz-1-ziggy", BACKUP_DATASET):
        raise SafetyStop("CT 420 destination bind dataset already exists")
    for host in ("pve-hz-1-ziggy", "pve-hz-3-ziggy"):
        projected = sum(g["referenced_bytes"] for g in selected if g["target"] == host)
        health(host, projected + (15 * GIB if host == "pve-hz-1-ziggy" else 0))
    for guest in selected:
        capture_snapshot(guest)
        stage_configs(guest)
        progress(guest["id"], phase="prepared", bytes_sent=0)
    manifest = {"run": RUN, "snapshot": SNAPSHOT, "prepared": now(),
                "baseline": baseline, "guests": selected}
    write_json(ROOT / "manifest.json", manifest)
    event("All ten base snapshots held and effective target configs staged outside /etc/pve.")


def wait_children(sender, receiver):
    sender_code = sender.wait(timeout=90)
    receiver_code = receiver.wait(timeout=90)
    if sender_code or receiver_code:
        raise RuntimeError(f"SSH stream exit codes: source={sender_code}, target={receiver_code}")


def stop_children(children):
    for child in children:
        if child.poll() is None:
            child.terminate()
    for child in children:
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=10)


def transfer_health(guest):
    check_pause()
    health(guest["source"])
    health(guest["target"])
    assert_source_running(guest)
    assert_guest_absent(guest)


def pump(sender, receiver, guest, prior_bytes, check_health=None, report=None):
    check_health = check_health or transfer_health
    report = report or progress
    os.set_blocking(sender.stdout.fileno(), False)
    os.set_blocking(receiver.stdin.fileno(), False)
    pending, eof, sent, credit = b"", False, 0, 0.0
    last_tick = last_report = time.monotonic()
    last_health = last_tick - 60
    while not eof or pending:
        check_pause()
        tick = time.monotonic()
        credit = min(RATE / 4, credit + RATE * (tick - last_tick))
        last_tick = tick
        if tick - last_health >= 60:
            check_health(guest)
            last_health = time.monotonic()
        if receiver.poll() is not None:
            raise RuntimeError(f"Destination receiver exited: {receiver.returncode}")
        readers = [sender.stdout] if not eof and len(pending) < 131072 else []
        writers = [receiver.stdin] if pending and credit >= 65536 else []
        readable, writable, _ = select.select(readers, writers, [], 0.1)
        if readable:
            chunk = os.read(sender.stdout.fileno(), 65536)
            if chunk:
                pending += chunk
            else:
                eof = True
        if writable:
            count = os.write(receiver.stdin.fileno(), pending[:min(65536, int(credit))])
            pending, credit, sent = pending[count:], credit - count, sent + count
        if tick - last_report >= 5:
            report(guest["id"], phase="transferring", bytes_sent=prior_bytes + sent)
            last_report = tick
    receiver.stdin.close()
    wait_children(sender, receiver)
    return prior_bytes + sent


def stream_once(guest, send_args):
    state_path = STATE / "progress" / f"{guest['id']}.json"
    prior = json.loads(state_path.read_text()).get("bytes_sent", 0)
    source_log = STATE / "logs" / f"{guest['id']}.send.log"
    target_log = STATE / "logs" / f"{guest['id']}.receive.log"
    receive = ["sudo", "-n", "zfs", "receive", "-s", "-u", *protect_args(guest), guest["dataset"]]
    with source_log.open("ab") as source_errors, target_log.open("ab") as target_errors:
        children = []
        try:
            receiver = subprocess.Popen(ssh_args(guest["target"], receive),
                                        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                        stderr=target_errors)
            children.append(receiver)
            sender = subprocess.Popen(
                ssh_args(guest["source"], ["sudo", "-n", "zfs", "send", *send_args]),
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=source_errors,
            )
            children.append(sender)
            return pump(sender, receiver, guest, prior)
        finally:
            stop_children(children)


def choose_send(guest):
    host, dataset = guest["target"], guest["dataset"]
    if not exists(host, dataset):
        return ["-Lcp", f"{dataset}@{SNAPSHOT}"]
    if prop(host, dataset, "echo:migration") != RUN or prop(host, dataset, "readonly") != "on":
        raise SafetyStop(f"Destination dataset is not a protected migration copy: {dataset}")
    token = prop(host, dataset, "receive_resume_token")
    if token != "-":
        details = zfs(guest["source"], "send", "-nPv", "-t", token)
        validate_resume_token(guest, details)
        event(f"Guest {guest['id']}: resuming interrupted receive.")
        return ["-t", token]
    verify_received(guest)
    return None


def validate_resume_token(guest, details):
    names = re.findall(r"^\s*toname = (.+)$", details, re.MULTILINE)
    guids = re.findall(r"^\s*toguid = (0x[0-9a-fA-F]+)$", details, re.MULTILINE)
    if names != [f"{guest['dataset']}@{SNAPSHOT}"] or len(guids) != 1:
        raise SafetyStop(f"Resume token addresses an unexpected snapshot for {guest['id']}")
    if str(int(guids[0], 16)) != guest["snapshot_guid"]:
        raise SafetyStop(f"Resume token GUID mismatch for {guest['id']}")


def receive_base(guest):
    for attempt in range(1, 6):
        try:
            transfer_health(guest)
            send_args = choose_send(guest)
            if send_args is not None:
                progress(guest["id"], phase="transferring", attempt=attempt, error=None)
                sent = stream_once(guest, send_args)
                progress(guest["id"], bytes_sent=sent)
            verify_received(guest)
            snapshot = f"{guest['dataset']}@{SNAPSHOT}"
            holds = zfs(guest["target"], "holds", "-H", snapshot)
            if not any(line.split()[1] == HOLD for line in holds.splitlines()):
                zfs(guest["target"], "hold", HOLD, snapshot)
            return
        except SafetyStop:
            raise
        except Exception as exc:
            event(f"Guest {guest['id']}: transfer attempt {attempt} failed ({type(exc).__name__}); "
                  "partial receive retained. See private transfer logs.")
            if attempt == 5:
                raise
            progress(guest["id"], phase="retry_wait", error=type(exc).__name__)
            deadline = time.monotonic() + min(30 * attempt, 120)
            while time.monotonic() < deadline:
                check_pause()
                time.sleep(1)


def rsync_command(source, destination):
    user = pwd.getpwuid(os.getuid()).pw_name
    transport = shlex.join([
        "sudo", "-n", "--preserve-env=SSH_AUTH_SOCK", "-u", user, "ssh", *SSH_OPTIONS,
    ])
    return [
        "sudo", "-n", "--preserve-env=SSH_AUTH_SOCK", "rsync", "-aHAXS", "--numeric-ids", "--partial",
        "--partial-dir=.rsync-partial", "--bwlimit=5120", "--stats",
        "--rsync-path=sudo -n rsync", "-e", transport, source, destination,
    ]


def run_rsync_once(guest, source, destination, label):
    with (STATE / "logs" / f"420.{label}.log").open("ab") as log:
        child = subprocess.Popen(rsync_command(source, destination), stdout=log, stderr=log)
        try:
            last_health = 0
            while child.poll() is None:
                check_pause()
                if time.monotonic() - last_health >= 60:
                    transfer_health(guest)
                    last_health = time.monotonic()
                time.sleep(1)
            if child.returncode:
                raise RuntimeError(f"CT 420 {label} rsync failed: exit {child.returncode}")
        finally:
            stop_children([child])


def run_rsync(guest, source, destination, label):
    for attempt in range(1, 6):
        try:
            run_rsync_once(guest, source, destination, label)
            return
        except SafetyStop:
            raise
        except Exception:
            if attempt == 5:
                raise
            event(f"CT 420: {label} rsync interrupted; retry {attempt}; partial files retained.")
            deadline = time.monotonic() + min(30 * attempt, 120)
            while time.monotonic() < deadline:
                check_pause()
                time.sleep(1)


def copy_bind_mount(guest):
    host = guest["target"]
    progress(420, phase="copying_bind_mount")
    if not exists(host, BACKUP_DATASET):
        if remote(host, "sudo", "-n", "test", "-e", BACKUP_PATH, check=False).returncode == 0:
            raise SafetyStop("CT 420 target bind path already exists")
        zfs(host, "create", "-o", "compression=lz4", "-o", "canmount=noauto",
            "-o", "acltype=posixacl", "-o", "xattr=sa",
            "-o", f"mountpoint={BACKUP_PATH}", "-o", f"echo:migration={RUN}", BACKUP_DATASET)
    if prop(host, BACKUP_DATASET, "echo:migration") != RUN:
        raise SafetyStop("CT 420 bind dataset is not owned by this migration")
    if exists(host, f"{BACKUP_DATASET}@{SNAPSHOT}"):
        if prop(host, BACKUP_DATASET, "readonly") != "on" or prop(host, BACKUP_DATASET, "mounted") != "no":
            raise SafetyStop("CT 420 completed bind copy is not protected")
        return
    local = STATE / "backup-data"
    if not local.exists():
        local.mkdir(mode=0o700)
    run_rsync(guest, f"{guest['source']}:{BACKUP_PATH}/", f"{local}/", "pull")
    zfs(host, "set", "readonly=off", BACKUP_DATASET)
    if prop(host, BACKUP_DATASET, "mounted") != "yes":
        zfs(host, "mount", BACKUP_DATASET)
    try:
        run_rsync(guest, f"{local}/", f"{host}:{BACKUP_PATH}/", "push")
    finally:
        zfs(host, "unmount", BACKUP_DATASET)
        zfs(host, "set", "readonly=on", BACKUP_DATASET)
    zfs(host, "snapshot", f"{BACKUP_DATASET}@{SNAPSHOT}")
    zfs(host, "hold", HOLD, f"{BACKUP_DATASET}@{SNAPSHOT}")
    event("CT 420: separate bind-mount base copied; target read-only and unmounted.")


def seed_guest(guest):
    ident = guest["id"]
    receive_base(guest)
    if ident == 420:
        copy_bind_mount(guest)
    progress(ident, phase="base_verified", verified=now(), error=None)
    event(f"Guest {ident} {guest['name']}: base verified on {guest['target']}; "
          "source still running; no cutover.")
    notify_base(guest)


def notify_base(guest):
    ident = guest["id"]
    notify(
        f"Hetzner migration: base staged and verified for {ident} {guest['name']} "
        f"on {guest['target']} ({guest['stream_bytes'] / GIB:.1f} GiB root/disk stream"
        + (", plus /backup" if ident == 420 else "")
        + "). Source remains running. No cutover; autostart settings unchanged.",
        f"base-{ident}",
    )


def source_worker(selected):
    for guest in selected:
        try:
            check_pause()
            seed_guest(guest)
        except Exception as exc:
            phase = "paused" if isinstance(exc, SafetyStop) else "failed"
            progress(guest["id"], phase=phase, error=str(exc))
            event(f"Guest {guest['id']}: {phase}; source unchanged. {exc}")
            raise


def seed():
    manifest = load_manifest()
    failures = []
    pause_notified = False
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        jobs = {
            pool.submit(source_worker, [g for g in manifest["guests"] if g["source"] == source]): source
            for source in ("echo-mothership-01", "echo-mothership-02")
        }
        for job in concurrent.futures.as_completed(jobs):
            try:
                job.result()
            except Exception as exc:
                failures.append(f"{jobs[job]}: {exc}")
                if isinstance(exc, SafetyStop) and (STATE / "STOP").exists():
                    if not pause_notified:
                        notify("Hetzner base transfers paused through the operator STOP control. "
                               "Partial copies retained for resume; source guests remain running. "
                               "No cutover or autostart changes.",
                               f"stage1-paused-{now()}")
                        pause_notified = True
                else:
                    notify(f"Hetzner base migration needs attention: {jobs[job]} worker stopped "
                           f"({type(exc).__name__}). Sources remain unchanged; partial copies retained. "
                           "See archive/2026-09-25-hetzner-migration/STATUS.md.",
                           f"worker-failed-{jobs[job]}-{now()}")
    if failures:
        if (STATE / "STOP").exists():
            raise SafetyStop("; ".join(failures))
        raise RuntimeError("; ".join(failures))
    for guest in manifest["guests"]:
        verify_received(guest)
        assert_source_running(guest)
    event("Stage 1 complete: ten base snapshots and CT 420 bind mount verified. Awaiting showtime.")
    notify("Hetzner migration Stage 1 COMPLETE: all 10 base snapshots and CT 420 /backup "
           "are staged and verified. All source guests remain running; no destination "
           "guest is registered or booted. Awaiting your showtime instruction for warm "
           "incrementals and sequential cutovers (15-minute per-guest budget). "
           "Source autostart will be disabled before shutdown; target enabled after validation.",
           "stage1-complete")


def request_signal_pause(signum, frame):
    path = STATE / "STOP"
    if not path.exists():
        path.write_text(f"Received {signal.Signals(signum).name} at {now()}.\n")


def main():
    parser = argparse.ArgumentParser(description="Stage-only migration; never starts or stops guests")
    parser.add_argument("action", choices=("prepare", "seed", "status"))
    args = parser.parse_args()
    ensure_state()
    if args.action == "status":
        render_status()
        print((ROOT / "STATUS.md").read_text())
        return
    with (STATE / "seed.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == "prepare":
            prepare()
        else:
            for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                signal.signal(signum, request_signal_pause)
            seed()


if __name__ == "__main__":
    try:
        main()
    except SafetyStop as exc:
        print(f"Paused safely: {exc}", flush=True)
        sys.exit(2)
