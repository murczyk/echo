import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

import storage_policy as policy


class StoragePolicy3835Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.data_path = root / "streams"
        self.data_path.mkdir()
        runtime = root / "runtime"
        runtime.mkdir()
        self.runtime = runtime / "current_config.toml"
        self.runtime.write_text("[data_maintenance.messages]\ncleaner_enabled = false\n")
        self.recent = int(time.time() * 1_000_000)
        self.old = self.recent - 31 * 86400 * 1_000_000

    def segment(self, topic, offset, timestamp, size=4096, sparse=False):
        folder = self.data_path / f"0/topics/{topic}/partitions/0"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{offset:020}.log"
        with path.open("wb") as log:
            if sparse:
                log.truncate(size)
            else:
                log.write(os.urandom(size))
        path.with_suffix(".index").write_bytes(policy.INDEX_RECORD.pack(0, size, timestamp))
        return path

    def run_policy(self, api, max_bytes=policy.MAX_STORAGE_BYTES, apply=True, **kwargs):
        with contextlib.redirect_stdout(io.StringIO()):
            policy.run_policy(api, self.data_path, max_bytes, 30, apply, **kwargs)

    def test_3835_budget_uses_allocated_bytes_and_never_deletes_active_segments(self):
        oldest = self.segment(0, 0, self.recent, size=1_000_000_000, sparse=True)
        for offset in range(1, 101):
            self.segment(0, offset, self.recent, size=1_000_000_000, sparse=True)
        active = self.segment(0, 101, self.old)
        self.run_policy(FakeApi(self.data_path))
        self.assertTrue(oldest.exists())
        self.assertTrue(active.exists())

    def test_3835_global_cap_deletes_oldest_sealed_segments_across_topics(self):
        newer = self.segment(0, 0, self.recent - 100)
        active0 = self.segment(0, 1, self.recent)
        oldest = self.segment(1, 0, self.recent - 200)
        active1 = self.segment(1, 1, self.recent)
        allocated, partitions = policy.storage_snapshot(self.data_path)
        budget = allocated - partitions[(0, 1, 0)][0].allocated_bytes
        api = FakeApi(self.data_path)
        self.run_policy(api, max_bytes=budget)
        self.assertFalse(oldest.exists())
        for path in (newer, active0, active1):
            self.assertTrue(path.exists())
        self.assertEqual(len(api.deletions), 1)

    def test_3835_expiry_uses_newest_message_timestamp_not_file_mtime(self):
        old = self.segment(0, 0, self.old)
        recent = self.segment(0, 1, self.recent)
        active = self.segment(0, 2, self.recent)
        os.utime(recent, (1, 1))
        self.run_policy(FakeApi(self.data_path))
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(active.exists())

    def test_3835_dry_run_never_updates_topics_or_deletes_data(self):
        old = self.segment(0, 0, self.old)
        self.segment(0, 1, self.recent)
        api = FakeApi(self.data_path)
        api.topics[0]["message_expiry"] = 2**64 - 1
        self.run_policy(api, apply=False)
        self.assertTrue(old.exists())
        self.assertEqual(api.mutations, [])

    def test_3835_segment_spanning_age_cutoff_is_retained(self):
        old = self.segment(0, 0, self.old)
        spanning = self.segment(0, 1, self.old)
        spanning.with_suffix(".index").write_bytes(
            policy.INDEX_RECORD.pack(0, 1, self.old)
            + policy.INDEX_RECORD.pack(1, 2, self.recent)
        )
        self.segment(0, 2, self.recent)
        self.run_policy(FakeApi(self.data_path))
        self.assertFalse(old.exists())
        self.assertTrue(spanning.exists())

    def test_3835_repairs_repeated_policy_resets_without_overwriting_other_settings(self):
        self.segment(0, 0, self.recent)
        api = FakeApi(self.data_path)
        for _ in range(2):
            api.topics[0]["message_expiry"] = 2**64 - 1
            self.run_policy(api)
            self.assertEqual(api.topics[0]["message_expiry"], 30 * 86400 * 1_000_000)
            self.assertEqual(api.topics[0]["compression_algorithm"], "gzip")
            self.assertEqual(api.topics[0]["replication_factor"], 3)
            self.assertEqual(api.topics[0]["max_topic_size"], 2**64 - 1)
        mutations = len(api.mutations)
        self.run_policy(api)
        self.assertEqual(len(api.mutations), mutations)

    def test_3835_verifies_topic_updates_before_deleting_any_data(self):
        old = self.segment(0, 0, self.old)
        self.segment(0, 1, self.recent)
        api = FakeApi(self.data_path)
        api.topics[0]["message_expiry"] = 2**64 - 1
        api.ignore_updates = True
        with self.assertRaisesRegex(RuntimeError, "verification failed"):
            self.run_policy(api)
        self.assertTrue(old.exists())
        self.assertEqual(api.deletions, [])

    def test_3835_blocked_consumers_stop_cleanup_without_advancing_offsets(self):
        old = self.segment(0, 0, self.old)
        active = self.segment(0, 1, self.recent)
        api = FakeApi(self.data_path)
        api.block_deletions = True
        with self.assertRaisesRegex(RuntimeError, "consumer offsets"):
            self.run_policy(api)
        self.assertTrue(old.exists())
        self.assertTrue(active.exists())
        self.assertEqual([method for method, _ in api.mutations], ["DELETE"])

    def test_3835_refuses_native_cleaner_and_mismatched_api_inventory(self):
        self.segment(0, 0, self.recent)
        api = FakeApi(self.data_path)
        self.runtime.write_text("[data_maintenance.messages]\ncleaner_enabled = true\n")
        with self.assertRaisesRegex(RuntimeError, "native cleaner"):
            self.run_policy(api)
        self.runtime.write_text("[data_maintenance.messages]\ncleaner_enabled = false\n")
        api.topics[0]["partitions"] = []
        api.topics[0]["message_expiry"] = 2**64 - 1
        with self.assertRaisesRegex(RuntimeError, "do not match"):
            self.run_policy(api)
        self.assertEqual(api.mutations, [])

    def test_3835_bad_indexes_and_symlinks_fail_before_mutation(self):
        path = self.segment(0, 0, self.old)
        self.segment(0, 1, self.recent)
        api = FakeApi(self.data_path)
        path.with_suffix(".index").write_bytes(b"partial index")
        with self.assertRaisesRegex(RuntimeError, "Invalid sealed"):
            self.run_policy(api)
        self.assertEqual(api.mutations, [])
        path.with_suffix(".index").unlink()
        path.with_suffix(".index").symlink_to(self.runtime)
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            self.run_policy(api)
        self.assertEqual(api.mutations, [])

    def test_3835_reports_the_consumer_holding_a_sealed_segment(self):
        old = self.segment(0, 0, self.old)
        old.with_suffix(".index").write_bytes(
            policy.INDEX_RECORD.pack(0, 1, self.old)
            + policy.INDEX_RECORD.pack(1, 2, self.old)
        )
        self.segment(0, 2, self.recent)
        offset = old.parent / "offsets/consumers/42"
        offset.parent.mkdir(parents=True)
        offset.write_bytes((0).to_bytes(8, "little"))
        api = FakeApi(self.data_path)
        api.block_deletions = True
        with self.assertRaisesRegex(RuntimeError, '"id": "42"'):
            self.run_policy(api)
        self.assertEqual(offset.read_bytes(), (0).to_bytes(8, "little"))

    def test_3835_caps_each_run_and_reports_unsatisfied_active_segment_budget(self):
        first = self.segment(0, 0, self.old)
        second = self.segment(0, 1, self.old)
        self.segment(0, 2, self.recent)
        api = FakeApi(self.data_path)
        with self.assertRaisesRegex(RuntimeError, "not satisfied"):
            self.run_policy(api, max_deletions=1)
        self.assertFalse(first.exists())
        self.assertTrue(second.exists())
        self.run_policy(api)
        with self.assertRaisesRegex(RuntimeError, "active segments"):
            self.run_policy(api, max_bytes=1)

    def test_3835_only_one_apply_process_can_own_the_policy_lock(self):
        path = Path(self.temp.name) / "lock"
        with policy.policy_lock(path, False):
            self.assertFalse(path.exists())
        with policy.policy_lock(path, True):
            with self.assertRaises(BlockingIOError):
                with policy.policy_lock(path, True):
                    self.fail("Concurrent cleanup acquired the lock")

    def test_3835_refuses_an_api_listener_from_another_local_server(self):
        self.runtime.write_text(
            "[data_maintenance.messages]\ncleaner_enabled = false\n"
            "[http]\nenabled = true\naddress = '0.0.0.0:3000'\n"
        )
        with self.assertRaisesRegex(RuntimeError, "does not match"):
            policy.verify_runtime(self.data_path, "http://127.0.0.1:3001")
        policy.verify_runtime(self.data_path, "http://127.0.0.1:3000")


class FakeApi:
    def __init__(self, data_path):
        self.data_path = data_path
        self.topics = {}
        for path in data_path.glob("0/topics/*"):
            topic_id = int(path.name)
            self.topics[topic_id] = {
                "id": topic_id, "name": f"topic-{topic_id}",
                "compression_algorithm": "gzip", "replication_factor": 3,
                "max_topic_size": 2**64 - 1,
                "message_expiry": 30 * 86400 * 1_000_000,
                "partitions": [{"id": 0}],
            }
        self.mutations = []
        self.deletions = []
        self.ignore_updates = False
        self.block_deletions = False

    def request(self, method, path, body=None):
        if method == "GET" and path == "/streams":
            return [{"id": 0}]
        if method == "GET" and path == "/streams/0/topics":
            return list(self.topics.values())
        topic_id = int(path.split("/")[4])
        if method == "GET":
            return json.loads(json.dumps(self.topics[topic_id]))
        self.mutations.append((method, path))
        if method == "PUT":
            if not self.ignore_updates:
                self.topics[topic_id].update(body)
            return
        if method == "DELETE":
            self.deletions.append(path)
            if not self.block_deletions:
                folder = self.data_path / f"0/topics/{topic_id}/partitions/0"
                oldest = sorted(folder.glob("*.log"))[0]
                oldest.unlink()
                oldest.with_suffix(".index").unlink()
            return
        raise AssertionError(f"Unexpected request: {method} {path}")


if __name__ == "__main__":
    unittest.main()
