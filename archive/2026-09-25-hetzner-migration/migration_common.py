import datetime
import json
import os
from pathlib import Path
import shlex
import subprocess
import threading
import urllib.request

ROOT = Path(__file__).resolve().parent
STATE = ROOT / ".state"
RUN = "20260925T083354Z"
SNAPSHOT = f"echo-hz-migrate-{RUN}-base"
HOLD = f"echo-hz-migrate-{RUN}"
REMOTE_STATE = f"/var/lib/echo-hz-migration/{RUN}"
RATE = 5 * 1024 * 1024
GIB = 1024 ** 3
POOL_LIMIT = 0.85
MEMORY_FLOOR = 32 * GIB
BACKUP_DATASET = "rpool/data/ct-420-backup"
BACKUP_PATH = "/mount-lxc/420/backup"
HOSTS = {
    "echo-mothership-01": "pve-1",
    "echo-mothership-02": "pve-2",
    "pve-hz-1-ziggy": "pve-hz-1",
    "pve-hz-3-ziggy": "pve-hz-3",
}
GUESTS = [
    (128, "ct-echo-vllm-router", "01", "3", "lxc", "100.105.172.96"),
    (127, "ct-echo-cbr-staging", "01", "1", "lxc", "100.64.63.98"),
    (126, "ct-echo-cbr", "01", "3", "lxc", "100.83.31.43"),
    (129, "srv-echo-ai-agent-vm", "01", "1", "qemu", "100.69.170.28"),
    (647, "ct-oblik-os-vault", "02", "3", "lxc", "100.113.72.99"),
    (650, "ct-kmz-converter", "02", "3", "lxc", "100.102.183.12"),
    (421, "ct-mattermost-cbr", "02", "3", "lxc", "100.121.33.7"),
    (420, "ct-gitlab-backup", "02", "1", "lxc", "100.120.137.40"),
    (131, "ct-ci-neo", "02", "1", "lxc", "100.121.228.69"),
    (405, "ct-signoz-echo", "02", "3", "lxc", "100.71.235.10"),
]
SSH_OPTIONS = [
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3", "-o", "Compression=no",
    "-o", "LogLevel=ERROR",
]
LOCAL_LOCK = threading.RLock()


class SafetyStop(RuntimeError):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.{threading.get_ident()}.tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(temporary, 0o600 if STATE in path.parents else 0o644)
    temporary.replace(path)


def ssh_args(host, args):
    if host not in HOSTS:
        raise SafetyStop(f"Host outside allowlist: {host}")
    return ["ssh", *SSH_OPTIONS, host, shlex.join([str(a) for a in args])]


def remote(host, *args, input=None, check=True):
    result = subprocess.run(
        ssh_args(host, args), input=input, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120,
    )
    if check and result.returncode:
        raise RuntimeError(f"{host}: {shlex.join(str(arg) for arg in args)}: {result.stderr.strip()}")
    return result


def output(host, *args):
    return remote(host, *args).stdout.strip()


def zfs(host, *args):
    return output(host, "sudo", "-n", "zfs", *args)


def prop(host, dataset, name):
    return zfs(host, "get", "-Hp", "-o", "value", name, dataset)


def exists(host, dataset):
    result = remote(host, "sudo", "-n", "zfs", "list", "-H", "-o", "name",
                    dataset, check=False)
    if result.returncode and "dataset does not exist" not in result.stderr:
        raise RuntimeError(f"{host}: could not check {dataset}: {result.stderr}")
    return result.returncode == 0


def guests():
    result = []
    for ident, name, source, target, kind, tailscale in GUESTS:
        prefix = "subvol" if kind == "lxc" else "vm"
        result.append({
            "id": ident, "name": name, "source": f"echo-mothership-{source}",
            "target": f"pve-hz-{target}-ziggy", "kind": kind,
            "dataset": f"rpool/data/{prefix}-{ident}-disk-0",
            "tailscale": tailscale,
        })
    return result


def validate_manifest(manifest):
    if manifest["run"] != RUN or manifest["snapshot"] != SNAPSHOT:
        raise SafetyStop("Wrong migration run or snapshot")
    expected = guests()
    actual = manifest["guests"]
    if len(actual) != len(expected):
        raise SafetyStop("Guest allowlist length changed")
    for original, candidate in zip(expected, actual):
        if any(candidate.get(key) != value for key, value in original.items()):
            raise SafetyStop(f"Guest allowlist changed: {original['id']}")
    return manifest


def load_manifest():
    return validate_manifest(json.loads((ROOT / "manifest.json").read_text()))


def config_values(text):
    values = {}
    for line in text.splitlines():
        if line.startswith("["):
            break
        key, separator, value = line.partition(": ")
        if separator:
            values[key] = value
    return values


def target_config(text, kind):
    lines = []
    for line in text.splitlines():
        if line.startswith("["):
            break
        if line.startswith(("parent:", "lock:", "onboot:")):
            continue
        if kind == "qemu" and line.startswith("ide2:"):
            lines.append("ide2: none,media=cdrom")
        else:
            lines.append(line)
    return "\n".join(lines).rstrip() + "\nonboot: 0\n"


def assert_guest_absent(guest):
    ident = str(guest["id"])
    script = (
        f"test -z \"$(find /etc/pve/nodes -path '*/lxc/{ident}.conf' "
        f"-o -path '*/qemu-server/{ident}.conf')\""
    )
    if remote(guest["target"], "sudo", "-n", "sh", "-c", script, check=False).returncode:
        raise SafetyStop(f"Destination guest {ident} is now registered")


def health(host, remaining=0):
    if output(host, "hostname") != HOSTS[host]:
        raise SafetyStop(f"Unexpected identity for {host}")
    row = output(host, "sudo", "-n", "zpool", "list", "-Hp",
                 "-o", "size,allocated,health", "rpool").split()
    size, allocated = int(row[0]), int(row[1])
    if row[2] != "ONLINE" or (allocated + remaining) / size >= POOL_LIMIT:
        raise SafetyStop(f"{host}: pool unhealthy or projected usage >=85%")
    memory = output(host, "awk", "/MemAvailable/ {print $2}", "/proc/meminfo")
    if host.startswith("pve-hz") and int(memory) * 1024 < MEMORY_FLOOR:
        raise SafetyStop(f"{host}: less than 32 GiB RAM available")
    return {"time": now(), "pool_size": size, "pool_allocated": allocated,
            "mem_available": int(memory) * 1024}


def progress(ident, **updates):
    path = STATE / "progress" / f"{ident}.json"
    with LOCAL_LOCK:
        value = json.loads(path.read_text()) if path.exists() else {"id": ident}
        value.update(updates, updated=now())
        write_json(path, value)
        render_status()
    return value


def render_status():
    rows = []
    for guest in guests():
        path = STATE / "progress" / f"{guest['id']}.json"
        status = json.loads(path.read_text()) if path.exists() else {}
        transferred = status.get("bytes_sent", 0) / GIB
        rows.append(
            f"| {guest['id']} | {guest['target']} | {status.get('phase', 'pending')} "
            f"| {transferred:.2f} | {status.get('updated', '')} |"
        )
    notice = (
        "**Showtime authorized. See [CUTOVER.md](CUTOVER.md) for current guest locations "
        "and autostart state. The table below records completed base staging.**\n\n"
        if (ROOT / "CUTOVER.md").exists() else
        "**No cutover performed. Source guests retain their original autostart "
        "settings. Destination guest configurations are not registered.**\n\n"
    )
    text = (
        "# Stage 1 status\n\n"
        f"Run: {RUN}. Updated: {now()}.\n\n"
        + notice +
        "| Guest | Destination | Phase | Stream GiB sent | Updated UTC |\n"
        "| --- | --- | --- | ---: | --- |\n" + "\n".join(rows) + "\n\n"
        "Stream bytes include retries and exclude CT 420's separate bind-mount copy. "
        "A verified base is not an application-consistent final cutover snapshot.\n"
    )
    temporary = ROOT / f"STATUS.md.{os.getpid()}.{threading.get_ident()}.tmp"
    temporary.write_text(text)
    temporary.replace(ROOT / "STATUS.md")


def event(message):
    line = f"- {now()}: {message}"
    with LOCAL_LOCK:
        with (ROOT / "PROCESS.md").open("a") as handle:
            handle.write(line + "\n")
        print(line, flush=True)


def check_pause():
    if (STATE / "STOP").exists():
        raise SafetyStop("Operator pause requested through .state/STOP")


def notify(message, key):
    path = STATE / "notifications.json"
    with LOCAL_LOCK:
        sent = json.loads(path.read_text()) if path.exists() else {}
        if key in sent:
            return
        hook = None
        for line in (ROOT.parent.parent / ".env").read_text().splitlines():
            name, separator, value = line.partition("=")
            if separator and name.strip() == "MATTERMOST_NOTIFICATION_HOOK":
                hook = value.strip().strip("'\"")
                break
        if not hook:
            raise RuntimeError("Mattermost notification hook is unavailable")
        request = urllib.request.Request(
            hook, data=json.dumps({"text": message}).encode(),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                response.read()
        except Exception as exc:
            raise RuntimeError(f"Mattermost notification failed: {type(exc).__name__}") from None
        sent[key] = now()
        write_json(path, sent)


def protect_args(guest):
    result = ["-o", "readonly=on", "-o", f"echo:migration={RUN}"]
    return result + ["-o", "canmount=noauto" if guest["kind"] == "lxc" else "volmode=none"]


def verify_received(guest):
    host, dataset = guest["target"], guest["dataset"]
    expected_type = "filesystem" if guest["kind"] == "lxc" else "volume"
    expected = {"type": expected_type, "readonly": "on", "echo:migration": RUN,
                "receive_resume_token": "-"}
    expected.update({"canmount": "noauto", "mounted": "no"} if guest["kind"] == "lxc"
                    else {"volmode": "none", "refreservation": "0"})
    for name, value in expected.items():
        if prop(host, dataset, name) != value:
            raise SafetyStop(f"{host}: {dataset} unexpected {name}")
    if prop(host, f"{dataset}@{SNAPSHOT}", "guid") != guest["snapshot_guid"]:
        raise SafetyStop(f"{host}: snapshot GUID mismatch for {dataset}")
    assert_guest_absent(guest)
