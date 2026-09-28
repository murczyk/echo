#!/usr/bin/env python3
import argparse
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import uuid


WORKERS = ("dev-back", "dev-bgworker", "dev-front", "dev-py")
STOP_GRACE_SECONDS = 5
START_TIMEOUT_SECONDS = 10
ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / ".dev-runtime" / "dev-tmux"
STATE = RUNTIME / "session.json"
REGISTRY = Path("/tmp") / f"echo-dev-tmux-{os.getuid()}"


def process_info(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {
            "pid": int(pid), "parent": int(fields[1]),
            "started": fields[19], "state": fields[0],
        }
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None


def still_running(process):
    current = process_info(process["pid"])
    return (
        current is not None and current["started"] == process["started"]
        and current["state"] != "Z"
    )


def signal_process(process, signum):
    if still_running(process):
        try:
            os.kill(process["pid"], signum)
        except ProcessLookupError:
            pass


def process_snapshot():
    processes = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdecimal():
            process = process_info(entry.name)
            if process:
                processes.append(process)
    return processes


def descendants(parents=None, processes=None):
    processes = process_snapshot() if processes is None else processes
    parents = {os.getpid()} if parents is None else parents
    owned = []
    while parents:
        children = [process for process in processes if process["parent"] in parents]
        owned.extend(children)
        parents = {process["pid"] for process in children}
    return owned


def dev_checkout(process):
    directory = Path(f"/proc/{process['pid']}")
    try:
        if directory.stat().st_uid != os.getuid() or process["state"] == "Z":
            return None
        args = (directory / "cmdline").read_bytes().decode().strip("\0").split("\0")
        cwd = (directory / "cwd").resolve(strict=True)
    except (OSError, UnicodeError):
        return None
    executable = Path(args[0]).name
    script_names = {f"{worker}.sh" for worker in WORKERS}
    scripted = executable in {"bash", "sh"} and any(
        Path(arg).name in script_names for arg in args[1:]
    )
    recipe = executable == "just" and any(arg in WORKERS for arg in args[1:])
    rust = (
        executable in {"cargo", "cargo-watch", "wdintel-rs"}
        and "--mode=debug" in args
        and any(arg in {"server", "bgworker", "report-worker"} for arg in args)
    )
    frontend = executable in {"node", "nodejs", "npm", "npx"} and (
        ("server" in args and any("elm-land" in arg for arg in args[1:]))
        or ("build" not in args and any("/vite/" in arg for arg in args[1:]))
    )
    python = (
        (executable.startswith("python") or executable == "flask")
        and "--app" in args and "service" in args and "run" in args
    )
    supervisor = (
        executable.startswith("python") and "worker" in args
        and any(Path(arg).name == "dev-tmux.py" for arg in args[1:])
    )
    if not any((scripted, recipe, rust, frontend, python, supervisor)):
        return None
    for root in (cwd, *cwd.parents):
        if (root / "deploy/dev-back.sh").is_file() and (root / "wdintel-rs").is_dir():
            if frontend and not cwd.is_relative_to(root / "wdintel-web"):
                return None
            if python and not cwd.is_relative_to(root / "wdintel-rs/wdintel-py"):
                return None
            return root
    return None


def running_environments():
    environments = {}
    for process in process_snapshot():
        root = dev_checkout(process)
        if root is not None:
            environments.setdefault(root, []).append(process)
    return environments


def managed_instances():
    return [json.loads(path.read_text()) for path in REGISTRY.glob("*.json")]


def stop_unmanaged(roots):
    known = {}
    deadline = time.monotonic() + STOP_GRACE_SECONDS
    while True:
        processes = process_snapshot()
        matching = [process for process in processes if dev_checkout(process) in roots]
        alive = [process for process in known.values() if still_running(process)]
        owned = matching + alive + descendants({p["pid"] for p in matching + alive}, processes)
        owned = [process for process in owned if still_running(process)]
        if not owned:
            return
        force = time.monotonic() >= deadline
        for process in owned:
            identity = (process["pid"], process["started"])
            if force or identity not in known:
                signal_process(process, signal.SIGKILL if force else signal.SIGTERM)
            known[identity] = process
        if time.monotonic() > deadline + STOP_GRACE_SECONDS:
            raise RuntimeError("Some dev workers did not exit; refusing to start another environment")
        time.sleep(0.05)


def stop_environments(roots):
    for state in managed_instances():
        if Path(state["root"]) in roots:
            stop_instance(state)
    stop_unmanaged(roots)


def check_other_environments(force):
    roots = set(running_environments())
    roots.update(Path(state["root"]) for state in managed_instances() if session_owned(state))
    roots.discard(ROOT)
    if not roots:
        return
    locations = ", ".join(str(root) for root in sorted(roots))
    if not force:
        raise RuntimeError(
            f"Another Echo dev environment is running: {locations}. "
            "Run just dev-tmux --force to stop it and start this checkout."
        )
    print(f"Stopping other Echo dev environments: {locations}")
    stop_environments(roots)


def reap_children(command):
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        if not pid:
            return False
        if command is not None and pid == command.pid:
            command.returncode = os.waitstatus_to_exitcode(status)


def stop_descendants(command):
    deadline = time.monotonic() + STOP_GRACE_SECONDS
    terminated = set()
    while True:
        if reap_children(command):
            return
        processes = descendants()
        force = time.monotonic() >= deadline
        for process in processes:
            identity = (process["pid"], process["started"])
            if force or identity not in terminated:
                signal_process(process, signal.SIGKILL if force else signal.SIGTERM)
                terminated.add(identity)
        time.sleep(0.05)


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def run_worker(token, worker, just):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "Cannot supervise detached workers")
    stopping = 0

    def request_stop(signum, _frame):
        nonlocal stopping
        stopping = signum

    for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, request_stop)
    command = None
    try:
        write_json(RUNTIME / token / f"{worker}.json", process_info(os.getpid()))
        if not stopping:
            command = subprocess.Popen([just, worker], cwd=ROOT, start_new_session=True)
            while not stopping and command.returncode is None:
                reap_children(command)
                time.sleep(0.05)
    finally:
        for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, signal.SIG_IGN)
        stop_descendants(command)
    status = 128 + stopping if stopping else (command.returncode if command else 0)
    if status < 0:
        status = 128 - status
    if not stopping:
        try:
            print(f"\n{worker} exited with status {status}.", flush=True)
        except OSError:
            pass
    return status


def tmux(socket, *args, check=True):
    prefix = ["tmux", "-S", socket] if socket else ["tmux"]
    return subprocess.run(prefix + list(args), text=True, capture_output=True, check=check)


def session_owned(state):
    result = tmux(
        state["socket"], "show-options", "-qv", "-t", state["session"],
        "@echo_dev_instance", check=False,
    )
    if result.returncode != 0 or result.stdout.strip() != state["token"]:
        return False
    root = tmux(
        state["socket"], "show-options", "-qv", "-t", state["session"],
        "@echo_dev_root", check=False,
    )
    return root.returncode == 0 and root.stdout.strip() == state["root"]


def registered_workers(state):
    directory = Path(state["root"]) / ".dev-runtime/dev-tmux" / state["token"]
    return [json.loads(path.read_text()) for path in directory.glob("*.json")]


def stop_instance(state):
    supervisors = registered_workers(state)
    if session_owned(state):
        panes = tmux(state["socket"], "list-panes", "-s", "-t", state["session"], "-F", "#{pane_pid}")
        supervisors.extend(process for pid in panes.stdout.split() if (process := process_info(pid)))
        tmux(state["socket"], "kill-session", "-t", state["session"])
    deadline = time.monotonic() + STOP_GRACE_SECONDS + START_TIMEOUT_SECONDS
    while True:
        running = [
            process for process in supervisors + registered_workers(state)
            if process["pid"] != os.getpid() and still_running(process)
        ]
        if not running:
            break
        for process in running:
            signal_process(process, signal.SIGTERM)
        if time.monotonic() >= deadline:
            raise RuntimeError("Worker cleanup is still running; retry just dev-tmux-stop")
        time.sleep(0.05)
    runtime = Path(state["root"]) / ".dev-runtime/dev-tmux"
    shutil.rmtree(runtime / state["token"], ignore_errors=True)
    (runtime / "session.json").unlink(missing_ok=True)
    (REGISTRY / f"{state['token']}.json").unlink(missing_ok=True)


def worker_command(state, worker, just):
    return "exec " + shlex.join([
        sys.executable, str(Path(__file__).resolve()), "worker", state["token"], worker, just,
    ])


def create_session(state, just):
    socket = state["socket"]
    commands = [
        "new-session", "-d", "-P", "-F", "#{session_id}\t#{socket_path}",
        "-s", state["name"], "-n", WORKERS[0], "-c", str(ROOT),
        "-e", f"PATH={os.environ['PATH']}", worker_command(state, WORKERS[0], just),
        ";", "set-option", "-t", f"={state['name']}:", "destroy-unattached", "off",
        ";", "set-option", "-t", f"={state['name']}:", "@echo_dev_instance", state["token"],
        ";", "set-option", "-t", f"={state['name']}:", "@echo_dev_root", str(ROOT),
        ";", "set-option", "-w", "-t", f"={state['name']}:", "remain-on-exit", "on",
        ";", "set-option", "-w", "-t", f"={state['name']}:", "automatic-rename", "off",
    ]
    result = tmux(socket, *commands)
    state["session"], state["socket"] = result.stdout.strip().split("\t")
    write_json(STATE, state)
    write_json(REGISTRY / f"{state['token']}.json", state)
    for worker in WORKERS[1:]:
        tmux(
            state["socket"], "new-window", "-d", "-t", state["session"],
            "-n", worker, "-c", str(ROOT), worker_command(state, worker, just),
            ";", "set-option", "-w", "-t", f"{state['session']}:{worker}",
            "remain-on-exit", "on",
            ";", "set-option", "-w", "-t", f"{state['session']}:{worker}",
            "automatic-rename", "off",
        )


def wait_for_workers(state):
    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    while len(registered_workers(state)) != len(WORKERS):
        if not session_owned(state) or time.monotonic() >= deadline:
            raise RuntimeError("Dev supervisors failed to start")
        time.sleep(0.05)


def start_session(force):
    check_other_environments(force)
    socket = os.environ.get("TMUX", "").rsplit(",", 2)[0] or None
    if STATE.exists():
        state = json.loads(STATE.read_text())
        if session_owned(state):
            if socket and socket != state["socket"]:
                raise RuntimeError("This checkout is running on another tmux server; stop it first")
            print(f"Session {state['name']} already exists. Select it with <bind> s.")
            return
        stop_instance(state)
    name = re.sub(r"[^a-zA-Z0-9_-]", "-", ROOT.name) + "-dev"
    if tmux(socket, "has-session", "-t", f"={name}", check=False).returncode == 0:
        raise RuntimeError(f"Refusing to replace unrelated tmux session {name}")
    state = {
        "name": name, "session": name, "socket": socket,
        "token": uuid.uuid4().hex, "root": str(ROOT),
    }
    (RUNTIME / state["token"]).mkdir()
    write_json(STATE, state)
    try:
        create_session(state, shutil.which("just"))
        wait_for_workers(state)
    except BaseException:
        stop_instance(state)
        raise
    print(f"Started {name}: {', '.join(WORKERS)}. Select it with <bind> s.")
    print(f"Outside tmux: {shlex.join(['tmux', '-S', state['socket'], 'attach', '-t', name])}")
    print("Stop all workers with: just dev-tmux-stop")


def main():
    parser = argparse.ArgumentParser(description="Run this checkout's dev workers in tmux (Linux).")
    parser.add_argument("action", choices=("start", "stop", "worker"))
    parser.add_argument("worker_args", nargs="*")
    parser.add_argument("--force", action="store_true", help="Stop other checkouts before starting")
    parser.add_argument("--all", action="store_true", help="Stop Echo dev environments in every checkout")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("dev-tmux requires Linux for detached worker cleanup")
    os.umask(0o077)
    if args.action == "worker":
        if len(args.worker_args) != 3 or args.worker_args[1] not in WORKERS:
            parser.error("worker requires an instance token, worker name, and just executable")
        token, worker, just = args.worker_args
        return run_worker(token, worker, just)
    if args.worker_args or (args.all and args.action != "stop") or (args.force and args.action != "start"):
        parser.error("--force belongs to start; --all belongs to stop")
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    for dependency in ("tmux", "just"):
        if not shutil.which(dependency):
            parser.error(f"{dependency} is required")
    RUNTIME.mkdir(parents=True, exist_ok=True)
    REGISTRY.mkdir(mode=0o700, exist_ok=True)
    if REGISTRY.is_symlink() or REGISTRY.stat().st_uid != os.getuid() or REGISTRY.stat().st_mode & 0o077:
        raise RuntimeError(f"Unsafe runtime directory: {REGISTRY}")
    with (REGISTRY / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.action == "start":
            start_session(args.force)
        elif args.all:
            roots = set(running_environments())
            roots.update(Path(state["root"]) for state in managed_instances())
            stop_environments(roots)
            print("Stopped all Echo dev environments.")
        elif STATE.exists():
            stop_instance(json.loads(STATE.read_text()))
            print("Stopped dev session and all its workers.")
        else:
            print("No managed dev session is running.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"dev-tmux: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.strip(), file=sys.stderr)
        sys.exit(1)
