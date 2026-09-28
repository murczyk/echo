#!/usr/bin/env python3
"""Process-ownership regressions for https://github.com/echoua/echo/issues/3620."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


SOURCE = Path(__file__).with_name("dev-tmux.py")
WORKERS = ("dev-back", "dev-bgworker", "dev-front", "dev-py")
SPEC = importlib.util.spec_from_file_location("dev_tmux", SOURCE)
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)

FIXTURE = r'''
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

worker = sys.argv[-1]
python = os.environ["ECHO_TMUX_TEST_PYTHON"]
directory = Path.cwd() / ".dev-runtime" / "fixture"
directory.mkdir(parents=True, exist_ok=True)

def record():
    pid = os.getpid()
    started = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    (directory / f"{worker}-{pid}.json").write_text(json.dumps({"pid": pid, "started": started}))

def spawn_child():
    return subprocess.Popen(
        ["wdintel-rs", __file__, "--mode=debug", "bgworker", "--child", worker],
        executable=python, start_new_session=True,
    )

if "--child" in sys.argv:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    record()
    while True:
        time.sleep(1)

record()
child = spawn_child()
if not (Path.cwd() / "unmanaged").exists():
    fork = os.fork()
    if fork == 0:
        os.setsid()
        if os.fork():
            os._exit(0)
        os.execv(python, [python, __file__, "--child", worker])
    os.waitpid(fork, 0)

def stop(_signum, _frame):
    if worker == "dev-back":
        spawn_child()
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
while len(list(directory.glob(f"{worker}-*.json"))) < (2 if (Path.cwd() / "unmanaged").exists() else 3):
    time.sleep(0.01)
(directory / f"{worker}.ready").touch()
if (Path.cwd() / "exit-worker").exists():
    sys.exit(17)
while True:
    time.sleep(1)
'''


def wait_until(predicate, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("Condition did not become true before timeout")


@unittest.skipUnless(sys.platform == "linux" and shutil.which("tmux"), "requires Linux and tmux")
class DevTmuxTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="echo-tmux-test-")
        self.directory = Path(self.temporary.name)
        self.registry = self.directory / "registry"
        self.socket = str(self.directory / "tmux.sock")
        self.environment = os.environ.copy()
        self.environment.pop("TMUX", None)
        self.environment.pop("TMUX_PANE", None)
        self.environment["ECHO_TMUX_TEST_MARKER"] = str(self.directory)
        self.environment["ECHO_TMUX_TEST_PYTHON"] = sys.executable
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        fixture = self.directory / "workers.py"
        fixture.write_text(FIXTURE)
        (self.bin / "just").write_text(
            "#!/bin/bash\nexec -a just " + shlex.join([sys.executable, str(fixture)]) + ' "$@"\n'
        )
        (self.bin / "just").chmod(0o755)
        self.environment["PATH"] = f"{self.bin}:{os.environ['PATH']}"
        self.tmux("-f", "/dev/null", "new-session", "-d", "-s", "unrelated", "sleep 600")
        self.environment["TMUX"] = f"{self.socket},1,0"
        self.roots = []
        self.root = self.checkout("echo-main")

    def checkout(self, name):
        root = self.directory / name
        (root / "deploy").mkdir(parents=True)
        (root / "wdintel-rs").mkdir()
        (root / "deploy/dev-back.sh").touch()
        driver = f'''
import importlib.util
import os
from pathlib import Path
import sys
import subprocess
spec = importlib.util.spec_from_file_location("dev_tmux", {str(SOURCE)!r})
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.__file__ = __file__
helper.ROOT = Path(__file__).resolve().parent.parent
helper.RUNTIME = helper.ROOT / ".dev-runtime/dev-tmux"
helper.STATE = helper.RUNTIME / "session.json"
helper.REGISTRY = Path({str(self.registry)!r})
snapshot = helper.process_snapshot
def isolated_snapshot():
    result = []
    for process in snapshot():
        try:
            environment = Path(f"/proc/{{process['pid']}}/environ").read_bytes().split(b"\\0")
            if {('ECHO_TMUX_TEST_MARKER=' + str(self.directory)).encode()!r} in environment:
                result.append(process)
        except OSError:
            pass
    return result
helper.process_snapshot = isolated_snapshot
try:
    sys.exit(helper.main())
except subprocess.CalledProcessError as error:
    print(error.stderr, file=sys.stderr)
    sys.exit(error.returncode)
'''
        (root / "deploy/dev-tmux.py").write_text(driver)
        self.roots.append(root)
        return root

    def tmux(self, *args, check=True):
        return subprocess.run(
            ["tmux", "-S", self.socket, *args], env=self.environment,
            capture_output=True, text=True, check=check, timeout=20,
        )

    def run_helper(self, action, *args, root=None, check=True, outside=False):
        root = root or self.root
        environment = self.environment.copy()
        if outside:
            environment.pop("TMUX", None)
        result = subprocess.run(
            [sys.executable, str(root / "deploy/dev-tmux.py"), action, *args],
            env=environment, cwd=root, capture_output=True, text=True, timeout=25,
        )
        if check:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def fixture_pids(self, root=None, worker=None):
        root = root or self.root
        pattern = f"{worker}-*.json" if worker else "*.json"
        return [json.loads(path.read_text()) for path in (root / ".dev-runtime/fixture").glob(pattern)]

    def ready(self, root=None):
        root = root or self.root
        wait_until(lambda: all((root / f".dev-runtime/fixture/{worker}.ready").exists() for worker in WORKERS))

    def gone(self, root=None, worker=None):
        wait_until(lambda: not any(HELPER.still_running(process) for process in self.fixture_pids(root, worker)))

    def tearDown(self):
        try:
            self.run_helper("stop", "--all")
            self.tmux("kill-server", check=False)
            for root in self.roots:
                for process in self.fixture_pids(root):
                    HELPER.signal_process(process, signal.SIGKILL)
        finally:
            self.temporary.cleanup()

    def test_start_reuse_and_stop_preserve_other_sessions(self):
        self.run_helper("start")
        self.ready()
        windows = self.tmux("list-windows", "-t", "echo-main-dev", "-F", "#{window_name}").stdout.split()
        self.assertEqual(windows, list(WORKERS))
        before = self.fixture_pids()
        self.assertIn("already exists", self.run_helper("start").stdout)
        self.assertEqual(self.fixture_pids(), before)
        self.run_helper("stop", outside=True)
        self.gone()
        self.run_helper("stop")
        self.tmux("has-session", "-t", "unrelated")
        self.assertNotEqual(self.tmux("has-session", "-t", "echo-main-dev", check=False).returncode, 0)

    def test_tmux_session_and_server_deletion_clean_detached_descendants(self):
        for command in ("kill-session", "kill-server"):
            with self.subTest(command=command):
                if command == "kill-server":
                    shutil.rmtree(self.root / ".dev-runtime/fixture")
                self.run_helper("start")
                self.ready()
                args = ("-t", "echo-main-dev") if command == "kill-session" else ()
                self.tmux(command, *args)
                self.gone()
                self.run_helper("stop")

    def test_ctrl_c_and_window_deletion_only_stop_their_worker(self):
        self.run_helper("start")
        self.ready()
        self.tmux("send-keys", "-t", "echo-main-dev:dev-back", "C-c")
        self.gone(worker="dev-back")
        self.tmux("kill-window", "-t", "echo-main-dev:dev-py")
        self.gone(worker="dev-py")
        self.assertTrue(all(HELPER.still_running(p) for p in self.fixture_pids(worker="dev-front")))

    def test_command_failure_remains_visible_after_children_are_cleaned(self):
        (self.root / "exit-worker").touch()
        self.run_helper("start")
        self.ready()
        self.gone()
        wait_until(lambda: self.tmux("list-panes", "-s", "-t", "echo-main-dev", "-F", "#{pane_dead}").stdout.split() == ["1"] * 4)
        for worker in WORKERS:
            self.assertIn(
                f"{worker} exited with status 17.",
                self.tmux("capture-pane", "-p", "-t", f"echo-main-dev:{worker}").stdout,
            )

    def test_force_replaces_another_checkout_and_all_stops_both_managed_and_manual(self):
        other = self.checkout("another checkout")
        self.environment["TMUX"] = f"{self.directory / 'other.sock'},1,0"
        try:
            self.run_helper("start", root=other)
        finally:
            self.environment["TMUX"] = f"{self.socket},1,0"
        self.ready(other)
        refused = self.run_helper("start", check=False)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("just dev-tmux --force", refused.stderr)
        self.assertTrue(any(HELPER.still_running(p) for p in self.fixture_pids(other)))
        self.run_helper("start", "--force")
        self.ready()
        self.gone(other)
        shutil.rmtree(other / ".dev-runtime/fixture")
        (other / "unmanaged").touch()
        manual = subprocess.Popen([str(self.bin / "just"), "dev-bgworker"], cwd=other, env=self.environment)
        bystander = subprocess.Popen(["sleep", "600"], cwd=other, env=self.environment)
        try:
            wait_until(lambda: (other / ".dev-runtime/fixture/dev-bgworker.ready").exists())
            self.assertNotEqual(self.run_helper("start", check=False).returncode, 0)
            self.run_helper("stop", "--all", outside=True)
            self.gone()
            self.gone(other)
            self.assertIsNotNone(manual.poll())
            self.assertIsNone(bystander.poll())
            self.tmux("has-session", "-t", "unrelated")
        finally:
            bystander.terminate()
            bystander.wait()
            if manual.poll() is None:
                manual.kill()
            manual.wait()

    def test_partial_startup_failure_cleans_started_workers(self):
        real_tmux = shutil.which("tmux")
        shim = self.bin / "tmux"
        shim.write_text(
            '#!/bin/bash\nif [[ " $* " == *" new-window "* && " $* " == *" dev-front "* ]]; then exit 23; fi\nexec '
            + shlex.quote(real_tmux) + ' "$@"\n'
        )
        shim.chmod(0o755)
        result = self.run_helper("start", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.gone()
        self.tmux("has-session", "-t", "unrelated")
        self.assertFalse((self.root / ".dev-runtime/dev-tmux/session.json").exists())

    def test_matching_unowned_session_is_not_replaced_or_stopped(self):
        self.tmux("new-session", "-d", "-s", "echo-main-dev", "sleep 600")
        result = self.run_helper("start", "--force", check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unrelated tmux session", result.stderr)
        self.run_helper("stop", "--all")
        self.tmux("has-session", "-t", "echo-main-dev")

    def test_stop_all_from_inside_managed_session_finishes_cleanup(self):
        self.run_helper("start")
        self.ready()
        command = "exec " + shlex.join([
            sys.executable, str(self.root / "deploy/dev-tmux.py"), "stop", "--all",
        ])
        self.tmux("new-window", "-d", "-t", "echo-main-dev", command)
        self.gone()
        wait_until(lambda: not (self.root / ".dev-runtime/dev-tmux/session.json").exists())
        self.tmux("has-session", "-t", "unrelated")


if __name__ == "__main__":
    unittest.main()
