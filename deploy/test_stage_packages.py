import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]


class CommandFixture:
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.log = self.directory / "commands.jsonl"
        self.environment = {
            **os.environ,
            "PATH": f"{self.directory}:{os.environ['PATH']}",
            "STAGE_TEST_LOG": str(self.log),
        }
        self.command("ssh", """
import subprocess, sys
raise SystemExit(subprocess.run(sys.argv[2:], input=sys.stdin.buffer.read()).returncode)
""")
        self.command("sudo", """
import subprocess, sys
raise SystemExit(subprocess.run(sys.argv[1:]).returncode)
""")
        self.command("apt-get", """
import json, os, sys
with open(os.environ['STAGE_TEST_LOG'], 'a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\\n')
if os.environ.get('STAGE_TEST_FAIL') in sys.argv[1:]:
    raise SystemExit(42)
""")

    def command(self, name, source):
        path = self.directory / name
        path.write_text("#!/usr/bin/env python3\n" + source)
        path.chmod(0o755)

    def run_stage(self, *arguments):
        return subprocess.run(
            ["bash", str(ROOT / "deploy/stage-packages.sh"), "fixture", *arguments],
            env=self.environment,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

class StagePackages(CommandFixture, unittest.TestCase):
    def test_packages_are_downloaded_without_installing_before_shutdown_3780(self):
        result = self.run_stage()
        self.assertEqual(result.returncode, 0, result.stderr)
        update, download = self.calls()
        self.assertIn("update", update)
        self.assertIn("--download-only", download)
        self.assertEqual(download[-2:], ["echo-install", "wdintel-rs"])

    def test_failed_preflight_stops_before_package_download_3780(self):
        self.environment["STAGE_TEST_FAIL"] = "update"
        result = self.run_stage()
        self.assertEqual(result.returncode, 42)
        self.assertEqual(len(self.calls()), 1)

    def test_local_package_and_dependencies_are_staged_without_installing_3780(self):
        package = Path("/var/tmp") / f"echo-stage-test-{uuid.uuid4().hex}.deb"
        package.touch()
        self.addCleanup(package.unlink)
        result = self.run_stage(str(package))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.calls()), 1)
        download = self.calls()[0]
        self.assertIn("--download-only", download)
        self.assertIn("--allow-downgrades", download)
        self.assertEqual(download[-1], str(package))

    def test_shell_metacharacters_are_rejected_before_ssh_3780(self):
        result = self.run_stage("/var/tmp/$(touch injected).deb")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.log.exists())


class MaintenanceMarker(CommandFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.command("ssh", """
import subprocess, sys
args=sys.argv[1:]
while args[0]=='-o': args=args[2:]
raise SystemExit(subprocess.run(args[1:], input=sys.stdin.buffer.read()).returncode)
""")
        self.command("redis-cli", """
import json, os, sys
args=sys.argv[1:]
with open(os.environ['STAGE_TEST_LOG'], 'a') as f:
    f.write(json.dumps(args) + '\\n')
print('0' if os.environ.get('STAGE_TEST_MARKER_MISSING') else '1')
""")

    def test_renewal_does_not_recreate_a_missing_marker_3780(self):
        self.environment["STAGE_TEST_MARKER_MISSING"] = "1"
        result = subprocess.run(
            ["bash", str(ROOT / "deploy/deployment-maintenance.sh"), "renew", "fixture"],
            env=self.environment, capture_output=True, text=True, timeout=5,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [["--raw", "EXPIRE", "echo:deployment:maintenance", "120"]])

    def test_deployment_can_stop_renewal_promptly_3780(self):
        process = subprocess.Popen(
            ["bash", str(ROOT / "deploy/deployment-maintenance.sh"), "keepalive", "fixture"],
            env=self.environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(50):
                if self.log.exists():
                    break
                time.sleep(0.02)
            self.assertTrue(self.log.exists())
            process.terminate()
            process.wait(timeout=2)
            self.assertEqual(len(self.calls()), 1)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)

    def test_stopping_keepalive_also_stops_inflight_ssh_3780(self):
        self.command("ssh", """
import os, signal, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
Path(os.environ['STAGE_TEST_LOG']).write_text(str(os.getpid()))
time.sleep(60)
""")
        process = subprocess.Popen(
            ["bash", str(ROOT / "deploy/deployment-maintenance.sh"), "keepalive", "fixture"],
            env=self.environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        ssh_pid = None
        try:
            for _ in range(100):
                if self.log.exists() and self.log.read_text():
                    ssh_pid = int(self.log.read_text())
                    break
                time.sleep(0.02)
            self.assertIsNotNone(ssh_pid)
            process.terminate()
            process.wait(timeout=3)
            for _ in range(100):
                status = Path(f"/proc/{ssh_pid}/stat")
                if not status.exists() or status.read_text().split()[2] == "Z":
                    break
                time.sleep(0.02)
            else:
                self.fail("SSH renewal survived keepalive termination")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=2)
            if ssh_pid is not None:
                try:
                    os.kill(ssh_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    unittest.main()
