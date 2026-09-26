#!/usr/bin/env python3
import hashlib
import json
import subprocess
import sys

from migration_common import RUN, STATE, event, load_manifest, output, remote, ssh_args, zfs

ALIAS = "echo-hz-migration-backup"
RECEIVER = "echo-gpu-hammer.mora-major.ts.net"
KEY = "/root/.ssh/echo_hz_backup_ed25519"
BINARY = "/usr/local/lib/echo-hz-migration/echo-install-utils"
CONFIG = "/etc/echo-hz-backup.toml"


def receiver(*args, input=None):
    return subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                           "echo-gpu-hammer", *args], input=input, text=True, check=True,
                          capture_output=True, timeout=60).stdout.strip()


def install_text(host, path, contents, mode="0600"):
    remote(host, "sudo", "-n", "tee", path, input=contents)
    output(host, "sudo", "-n", "chmod", mode, path)


def install_auth(host, public_address, host_key):
    output(host, "sudo", "-n", "install", "-d", "-m", "0700", "/root/.ssh")
    if remote(host, "sudo", "-n", "test", "-e", KEY, check=False).returncode:
        output(host, "sudo", "-n", "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", KEY,
               "-C", f"echo-hz-backup-{host}-{RUN}")
    public_key = output(host, "sudo", "-n", "cat", KEY + ".pub")
    addresses = [public_address, output(host, "sudo", "-n", "tailscale", "ip", "-4")]
    entry = f'from="{",".join(addresses)}",restrict {public_key}'
    script = """import os,sys
from pathlib import Path
p=Path.home()/'.ssh/authorized_keys'
p.parent.mkdir(mode=0o700,exist_ok=True)
s=p.read_text() if p.exists() else ''
entry=sys.stdin.read().strip()
if entry not in s.splitlines():
 with p.open('a') as f: f.write(('\\n' if s and not s.endswith('\\n') else '')+entry+'\\n')
os.chmod(p,0o600)
"""
    import shlex
    receiver("python3", "-c", shlex.quote(script), input=entry)
    known = f"{RECEIVER} {host_key}\n"
    install_text(host, "/root/.ssh/echo_hz_backup_known_hosts", known)
    stanza = (f"\nHost {ALIAS}\n    HostName {RECEIVER}\n    User echo\n"
              f"    IdentityFile {KEY}\n    IdentitiesOnly yes\n    BatchMode yes\n"
              "    StrictHostKeyChecking yes\n    UserKnownHostsFile /root/.ssh/echo_hz_backup_known_hosts\n")
    remote(host, "sudo", "-n", "python3", "-c",
           "from pathlib import Path; import sys,os; p=Path('/root/.ssh/config'); "
           "s=p.read_text() if p.exists() else ''; t=sys.stdin.read(); "
           "p.write_text(s+t) if 'Host echo-hz-migration-backup\\n' not in s else None; os.chmod(p,0o600)",
           input=stanza)
    actual = output(host, "sudo", "-n", "ssh", ALIAS, "hostname")
    if actual != "echo-gpu-hammer":
        raise RuntimeError("Backup receiver identity mismatch")


def install_binary(host, binary):
    output(host, "sudo", "-n", "install", "-d", "/usr/local/lib/echo-hz-migration")
    subprocess.run(ssh_args(host, ["sudo", "-n", "tee", BINARY]), input=binary,
                   stdout=subprocess.DEVNULL, check=True, timeout=60)
    output(host, "sudo", "-n", "chmod", "0755", BINARY)
    digest = output(host, "sudo", "-n", "sha256sum", BINARY).split()[0]
    if digest != hashlib.sha256(binary).hexdigest():
        raise RuntimeError("Backup executable checksum mismatch")


def install_config(host, selected):
    dataset = "rpool/echo-hz-backup-config"
    if remote(host, "sudo", "-n", "zfs", "list", dataset, check=False).returncode:
        zfs(host, "create", "-o", "compression=lz4", "-o", f"echo:migration={RUN}", dataset)
    lines = ["[zfs_backup]", "enabled = true", 'source_type = "proxmox"',
             f'source_name = "{host.removesuffix("-ziggy")}"', f'target_host = "{ALIAS}"',
             'target_dataset_root = "hdd0/proxmox-backups"', 'source_zfs_cmd = "zfs"',
             'target_zfs_cmd = "sudo -n zfs"', 'source_snapshot_mode = "zfs"',
             'snapshot_prefix = "incusbak"', 'retain_source_snapshots = 1',
             'retain_target_snapshots = 4', f'pve_config_dataset = "{dataset}"',
             'ssh_connect_timeout_seconds = 15', ""]
    for name in ["pve-config", *(g["name"] for g in selected)]:
        lines += ["[[zfs_backup.instances]]", f"name = {json.dumps(name)}",
                  "backup_interval_minutes = 10080", ""]
    install_text(host, CONFIG, "\n".join(lines))
    service = ("[Unit]\nDescription=Weekly ZFS backups for migrated Echo guests\n"
               "Wants=network-online.target\nAfter=network-online.target\n\n"
               "[Service]\nType=oneshot\nUser=root\nNice=10\nIOSchedulingClass=best-effort\n"
               "IOSchedulingPriority=7\nRuntimeDirectory=echo-hz-backup\n"
               f"ExecStart=/usr/bin/flock -n /run/echo-hz-backup/lock {BINARY} incus-zfs-backup --config {CONFIG}\n")
    hour = "01" if host == "pve-hz-1-ziggy" else "04"
    timer = ("[Unit]\nDescription=Check migrated Echo guest backups nightly\n\n[Timer]\n"
             f"OnCalendar=*-*-* {hour}:00:00 UTC\nRandomizedDelaySec=0\nPersistent=false\n\n"
             "[Install]\nWantedBy=timers.target\n")
    install_text(host, "/etc/systemd/system/echo-hz-backup.service", service, "0644")
    install_text(host, "/etc/systemd/system/echo-hz-backup.timer", timer, "0644")
    output(host, "sudo", "-n", "systemctl", "daemon-reload")
    event(f"Backup configuration prepared on {host}, restricted to migrated guest names and Proxmox config; timer not enabled yet.")


def main():
    binary = subprocess.run(ssh_args("echo-mothership-01", ["sudo", "-n", "cat", "/usr/local/bin/echo-install-utils"]),
                            capture_output=True, check=True, timeout=60).stdout
    host_key = receiver("sudo", "-n", "cat", "/etc/ssh/ssh_host_ed25519_key.pub")
    for host, address in (("pve-hz-1-ziggy", "142.132.150.5"), ("pve-hz-3-ziggy", "142.132.150.135")):
        install_auth(host, address, host_key)
        install_binary(host, binary)
        selected = [g for g in load_manifest()["guests"] if g["target"] == host]
        install_config(host, selected)


if __name__ == "__main__":
    main()
