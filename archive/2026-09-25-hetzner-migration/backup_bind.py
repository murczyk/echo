#!/usr/bin/env python3
import datetime
import fcntl
import json
import re
import shlex
import subprocess
import time

SOURCE = "rpool/data/ct-420-backup"
TARGET = "hdd0/proxmox-backups/pve-hz-1/ct-gitlab-backup/bind-backup"
ALIAS = "echo-hz-migration-backup"
PREFIX = "hzbindbak_"
PATTERN = re.compile(r"hzbindbak_\d{8}T\d{6}Z")


def command(args, receiver=False):
    if receiver:
        return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", ALIAS,
                shlex.join(["sudo", "-n", "zfs", *args])]
    return ["zfs", *args]


def run(args, receiver=False, check=True):
    return subprocess.run(command(args, receiver), check=check, text=True,
                          capture_output=True, timeout=90)


def prop(dataset, key, receiver=False):
    return run(["get", "-Hp", "-o", "value", key, dataset], receiver).stdout.strip()


def snapshots(dataset, receiver=False):
    result = run(["list", "-Hp", "-t", "snapshot", "-d", "1", "-s", "creation",
                  "-o", "name,guid,creation", dataset], receiver, check=False)
    if result.returncode:
        if "dataset does not exist" in result.stderr:
            return []
        raise RuntimeError(result.stderr)
    rows = []
    for line in result.stdout.splitlines():
        name, guid, created = line.split("\t")
        parent, _, label = name.partition("@")
        if parent == dataset and PATTERN.fullmatch(label):
            rows.append((label, guid, int(created)))
    return rows


def stream(args):
    sender = subprocess.Popen(command(["send", *args]), stdout=subprocess.PIPE)
    receiver = subprocess.Popen(command(["receive", "-s", "-u", "-o", "readonly=on",
        "-o", "canmount=off", "-o", "mountpoint=none", TARGET], True), stdin=sender.stdout)
    sender.stdout.close()
    receive_code = receiver.wait()
    send_code = sender.wait()
    if receive_code or send_code:
        raise RuntimeError(f"Resumable bind backup interrupted: send={send_code}, receive={receive_code}")


def backup():
    hostname = subprocess.check_output(["hostname", "-s"], text=True).strip()
    if hostname != "pve-hz-1" or prop(SOURCE, "echo:migration") != "20260925T083354Z":
        raise RuntimeError("Bind backup source identity mismatch")
    source_rows = snapshots(SOURCE)
    target_exists = run(["list", "-H", "-o", "name", TARGET], True, check=False).returncode == 0
    target_rows = snapshots(TARGET, True)
    token = prop(TARGET, "receive_resume_token", True) if target_exists else "-"
    if token == "-" and target_rows and time.time() - target_rows[-1][2] < 7 * 86400:
        print("Bind backup remains within the weekly interval", flush=True)
        return
    if token != "-":
        details = run(["send", "-nPv", "-t", token]).stdout
        names = re.findall(r"^\s*toname = (.+)$", details, re.MULTILINE)
        if len(names) != 1 or not names[0].startswith(SOURCE + "@"):
            raise RuntimeError("Unexpected bind backup resume token")
        label = names[0].split("@", 1)[1]
        if not PATTERN.fullmatch(label):
            raise RuntimeError("Unexpected bind backup snapshot")
        args = ["-t", token]
    else:
        label = PREFIX + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        run(["snapshot", SOURCE + "@" + label])
        target_guids = {row[1] for row in target_rows}
        common = [row for row in source_rows if row[1] in target_guids]
        if target_exists and not common:
            raise RuntimeError("Existing bind backup has no common snapshot; refusing forced receive")
        if not target_exists:
            run(["create", "-p", "-o", "mountpoint=none", TARGET.rsplit("/", 1)[0]], True)
        args = ["-Lcp"]
        if common:
            args += ["-i", SOURCE + "@" + common[-1][0]]
        args += [SOURCE + "@" + label]
    print(f"Sending {SOURCE}@{label} to {TARGET}", flush=True)
    stream(args)
    guid = prop(SOURCE + "@" + label, "guid")
    if guid != prop(TARGET + "@" + label, "guid", True) or prop(TARGET, "receive_resume_token", True) != "-":
        raise RuntimeError("Bind backup GUID/receive verification failed")
    for dataset, receiver, keep in ((SOURCE, False, 1), (TARGET, True, 4)):
        for old, _, _ in snapshots(dataset, receiver)[:-keep]:
            run(["destroy", dataset + "@" + old], receiver)
    print(json.dumps({"verified_snapshot": label, "guid": guid, "source_retention": 1, "target_retention": 4}), flush=True)


if __name__ == "__main__":
    with open("/run/echo-hz-bind-backup.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        backup()
