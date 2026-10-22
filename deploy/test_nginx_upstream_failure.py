import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def unused_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


@unittest.skipUnless(shutil.which("nginx"), "nginx is required")
class UpstreamFailure(unittest.TestCase):
    def test_missing_backend_returns_retryable_json_for_both_hosts_3780(self):
        for host in ["echo-skhid", "echo-pivnich"]:
            with self.subTest(host=host), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                port = unused_port()
                backend = unused_port()
                server = (ROOT / "deploy/nginx" / host).read_text()
                server = re.sub(r"^\s*(listen|ssl_certificate|ssl_certificate_key)\b.*$", "", server, flags=re.M)
                server = server.replace("127.0.0.1:8081", f"127.0.0.1:{backend}")
                server = server.replace("server {", f"server {{\nlisten 127.0.0.1:{port};", 1)
                configuration = directory / "nginx.conf"
                configuration.write_text(
                    f"pid {directory}/nginx.pid;\nerror_log {directory}/error.log;\n"
                    "events {}\nhttp { access_log off;\n" + server + "\n}"
                )
                process = subprocess.Popen(
                    ["nginx", "-p", temporary, "-c", str(configuration), "-g", "daemon off;"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
                try:
                    response = None
                    for _ in range(40):
                        try:
                            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/test", timeout=1)
                        except urllib.error.HTTPError as error:
                            response = error
                            break
                        except urllib.error.URLError:
                            if process.poll() is not None:
                                self.fail(process.stderr.read().decode())
                            time.sleep(0.05)
                    self.assertIsNotNone(response)
                    self.assertEqual(response.code, 503)
                    self.assertEqual(response.headers["Retry-After"], "1")
                    self.assertIn("no-store", response.headers["Cache-Control"])
                    self.assertIn("application/json", response.headers["Content-Type"])
                    self.assertIn("error", json.loads(response.read()))
                finally:
                    process.terminate()
                    process.wait(timeout=5)
                    process.stderr.close()


if __name__ == "__main__":
    unittest.main()
