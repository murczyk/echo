import base64
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

import storage_policy as policy


@unittest.skipUnless(os.environ.get("IGGY_TEST_BINARY"), "Set IGGY_TEST_BINARY to a local iggy-server")
class LiveStoragePolicy3835Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="echo-3835-iggy-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data_path = self.root / "local_data/streams"
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.url = f"http://127.0.0.1:{listener.getsockname()[1]}"
        config = f'''[system]
path = "{self.root}/local_data"
[system.sharding]
cpu_allocation = "1"
[system.segment]
size = "1 MiB"
[system.logging]
file_enabled = false
[tcp]
enabled = false
[quic]
enabled = false
[websocket]
enabled = false
[http]
enabled = true
address = "{self.url.removeprefix('http://')}"
[data_maintenance.messages]
cleaner_enabled = false
[message_saver]
enabled = true
interval = "10 ms"
'''
        (self.root / "config.toml").write_text(config)
        self.env = dict(os.environ, IGGY_CONFIG_PATH=str(self.root / "config.toml"),
                        IGGY_ROOT_USERNAME="test-root", IGGY_ROOT_PASSWORD="test-password",
                        IGGY_FORCE_POLL_DRIVER="true")
        self.output = (self.root / "server.log").open("w+")
        self.addCleanup(self.output.close)
        self.start()
        self.addCleanup(self.stop)
        self.api.request("POST", "/streams", {"name": "events"})
        for name in ("first", "second"):
            self.api.request("POST", "/streams/0/topics", {
                "name": name, "partitions_count": 1,
                "compression_algorithm": "none", "replication_factor": 1,
                "message_expiry": 2**64 - 1, "max_topic_size": 2**64 - 1,
            })
        self.seed_segments()

    def start(self):
        self.process = subprocess.Popen(
            [os.environ["IGGY_TEST_BINARY"]], cwd=self.root, env=self.env,
            stdout=self.output, stderr=subprocess.STDOUT,
        )
        for _ in range(100):
            if self.process.poll() is not None:
                break
            try:
                self.api = policy.IggyApi(self.url, "test-root", "test-password")
                if (self.root / "local_data/runtime/current_config.toml").exists():
                    return
            except OSError:
                pass
            time.sleep(0.05)
        self.stop()
        self.output.seek(0)
        self.fail(f"Isolated Iggy server failed to start:\n{self.output.read()[-4000:]}")

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()

    def seed_segments(self):
        for topic in (0, 1):
            for _ in range(9):
                messages = [
                    {"id": str(uuid.uuid4()), "payload": base64.b64encode(os.urandom(65536)).decode()}
                    for _ in range(8)
                ]
                self.api.request("POST", f"/streams/0/topics/{topic}/messages", {
                    "partitioning": {"kind": "balanced", "value": ""}, "messages": messages,
                })
                time.sleep(0.02)
        time.sleep(0.1)
        for _ in range(200):
            allocated, _ = policy.storage_snapshot(self.data_path)
            logical = sum(path.stat().st_size for path in self.data_path.rglob("*.log"))
            if allocated >= logical * 99 // 100:
                break
            time.sleep(0.05)
        else:
            self.fail("Filesystem did not publish allocated block counts")
        _, partitions = policy.storage_snapshot(self.data_path)
        self.assertTrue(all(len(segments) >= 2 for segments in partitions.values()))

    def run_policy(self, budget):
        result = subprocess.run(
            [sys.executable, str(Path(policy.__file__).resolve()), "--apply",
             "--data-path", str(self.data_path), "--url", self.url,
             "--max-bytes", str(budget), "--lock-file", str(self.root / "policy.lock")],
            env=self.env, capture_output=True, text=True, timeout=30,
        )
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)

    def test_3835_real_api_preserves_active_data_offsets_and_policy_after_restart(self):
        allocated, partitions = policy.storage_snapshot(self.data_path)
        oldest = min((segments[0] for segments in partitions.values()), key=lambda segment: segment.end_timestamp)
        oldest_count = oldest.path.with_suffix(".index").stat().st_size // 16
        active = {key: max((self.data_path / f"{key[0]}/topics/{key[1]}/partitions/{key[2]}").glob("*.log"))
                  for key in partitions}
        budget = allocated - oldest.allocated_bytes + 128 * 1024
        self.run_policy(budget)
        self.assertFalse(oldest.path.exists())
        self.assertTrue(all(path.exists() for path in active.values()))
        self.assertLessEqual(policy.storage_snapshot(self.data_path)[0], budget)
        for topic in (0, 1):
            details = self.api.request("GET", f"/streams/0/topics/{topic}")
            self.assertEqual(details["message_expiry"], 30 * 86400 * 1_000_000)
            self.assertEqual(details["messages_count"], 72 - oldest_count if topic == oldest.partition[1] else 72)
            self.assertGreater(details["messages_count"], 0)
        details = self.api.request("GET", "/streams/0/topics/0")
        settings = {name: details[name] for name in policy.TOPIC_SETTINGS}
        settings["message_expiry"] = 2**64 - 1
        self.api.request("PUT", "/streams/0/topics/0", settings)
        self.run_policy(budget)
        self.stop()
        self.start()
        self.assertEqual(self.api.request("GET", "/streams/0/topics/0")["message_expiry"], 30 * 86400 * 1_000_000)
        self.assertLessEqual(policy.storage_snapshot(self.data_path)[0], budget)
        for topic in (0, 1):
            messages = self.api.request("GET", f"/streams/0/topics/{topic}/messages?consumer_id=24&partition_id=0&kind=last&value=0&count=1&auto_commit=false")
            self.assertEqual(messages["messages"][0]["header"]["offset"], 71)

    def test_3835_real_consumer_barrier_is_reported_without_deleting_segments(self):
        self.api.request("GET", "/streams/0/topics/0/messages?consumer_id=23&partition_id=0&kind=first&value=0&count=1&auto_commit=true")
        allocated, partitions = policy.storage_snapshot(self.data_path)
        oldest = partitions[(0, 0, 0)][0]
        with self.assertRaisesRegex(RuntimeError, "consumer offsets"):
            self.run_policy(allocated - oldest.allocated_bytes)
        self.assertTrue(oldest.path.exists())
        self.assertEqual(policy.storage_snapshot(self.data_path)[0], allocated)


if __name__ == "__main__":
    unittest.main()
