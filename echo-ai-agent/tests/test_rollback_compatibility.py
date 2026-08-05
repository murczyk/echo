import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "bin" / "check-rollback-compatibility.py"
REQUEST_ID = "rollback-template-compatibility"


class RollbackCompatibilityTests(unittest.TestCase):
    def run_checker(self, response: bytes, returncode: int = 0):
        with tempfile.TemporaryDirectory() as directory:
            dispatcher = Path(directory) / "dispatcher"
            dispatcher.write_text(
                "#!/usr/bin/env python3\n"
                "import sys\n"
                "sys.stdin.buffer.read()\n"
                f"sys.stdout.buffer.write({response!r})\n"
                f"sys.exit({returncode})\n"
            )
            dispatcher.chmod(0o755)
            return subprocess.run(
                ["python3", str(CHECKER), str(dispatcher), "echo-staging"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

    def test_accepts_ready_template(self):
        response = json.dumps(
            {
                "id": REQUEST_ID,
                "ok": True,
                "done": True,
                "result": {"template_ready": True},
            }
        ).encode() + b"\n"

        self.assertEqual(self.run_checker(response).returncode, 0)

    def test_rejects_incompatible_template(self):
        response = json.dumps(
            {
                "id": REQUEST_ID,
                "ok": False,
                "done": True,
                "error": "selected template belongs to another harness release",
            }
        ).encode() + b"\n"

        self.assertEqual(self.run_checker(response).returncode, 1)

    def test_rejects_multiple_protocol_frames(self):
        response = (
            b'{"id":"rollback-template-compatibility","ok":true,"done":true,'
            b'"result":{"template_ready":true}}\n{}\n'
        )

        self.assertEqual(self.run_checker(response).returncode, 1)

    def test_rejects_dispatcher_failure(self):
        self.assertEqual(self.run_checker(b"", returncode=2).returncode, 1)


if __name__ == "__main__":
    unittest.main()
