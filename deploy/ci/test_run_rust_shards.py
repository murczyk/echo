from __future__ import annotations

import importlib.util
import signal
import socket
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).with_name("run_rust_shards.py")
SPEC = importlib.util.spec_from_file_location("run_rust_shards", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def result_line(passed: int, failed: int = 0, ignored: int = 0) -> str:
    outcome = "FAILED" if failed else "ok"
    return (
        f"test result: {outcome}. {passed} passed; {failed} failed; {ignored} ignored; "
        "0 measured; 0 filtered out; finished in 1.00s"
    )


def finished_shard(test_count: int, returncode: int = 0) -> MODULE.Shard:
    shard = MODULE.Shard(0, [f"test_{index}" for index in range(test_count)], Path("shard.log"))
    shard.process = mock.Mock(returncode=returncode)
    return shard


class AssignmentTests(unittest.TestCase):
    def test_every_test_lands_in_exactly_one_shard(self) -> None:
        names = [f"module::test_{index}" for index in range(1000)]
        shards = MODULE.assign_shards(names, 8)
        self.assertEqual(sorted(name for shard in shards for name in shard), sorted(names))

    def test_assignment_is_stable_and_salt_changes_it(self) -> None:
        names = [f"module::test_{index}" for index in range(100)]
        self.assertEqual(MODULE.assign_shards(names, 8), MODULE.assign_shards(names, 8))
        self.assertNotEqual(
            MODULE.assign_shards(names, 8), MODULE.assign_shards(names, 8, "salt")
        )

    def test_shards_are_roughly_balanced(self) -> None:
        names = [f"module::test_{index}" for index in range(3800)]
        sizes = [len(shard) for shard in MODULE.assign_shards(names, 8)]
        self.assertLess(max(sizes) - min(sizes), 120)


class ListingTests(unittest.TestCase):
    def test_keeps_only_test_entries(self) -> None:
        listing = "\n".join(
            [
                "module::first: test",
                "module::second: test",
                "module::measured: benchmark",
                "2026-11-04 INFO reading config: test",
            ]
        )
        self.assertEqual(
            MODULE.parse_test_names(listing), ["module::first", "module::second"]
        )


class ResultTests(unittest.TestCase):
    def test_last_result_line_describes_the_shard(self) -> None:
        log_text = "\n".join([result_line(1), "test child ... ok", result_line(40, ignored=2)])
        self.assertEqual(
            MODULE.parse_result(log_text), {"passed": 40, "failed": 0, "ignored": 2}
        )

    def test_missing_result_means_the_shard_never_finished(self) -> None:
        self.assertIsNone(MODULE.parse_result("thread 'main' panicked at src/tests.rs"))


class ProblemTests(unittest.TestCase):
    def test_complete_passing_shard_has_no_problem(self) -> None:
        shard = finished_shard(5)
        self.assertIsNone(MODULE.shard_problem(shard, result_line(4, ignored=1)))

    def test_failed_tests_are_a_problem(self) -> None:
        shard = finished_shard(5, returncode=101)
        problem = MODULE.shard_problem(shard, result_line(4, failed=1))
        self.assertEqual(problem, "1 tests failed")

    def test_crash_without_result_is_a_problem(self) -> None:
        shard = finished_shard(5, returncode=134)
        self.assertEqual(
            MODULE.shard_problem(shard, "ctor panicked"), "stopped without a test result"
        )

    def test_child_result_cannot_pass_for_a_crashed_shard(self) -> None:
        shard = finished_shard(5, returncode=134)
        self.assertEqual(
            MODULE.shard_problem(shard, result_line(1)), "finished 1 of 5 assigned tests"
        )

    def test_nonzero_exit_fails_even_with_a_clean_result(self) -> None:
        shard = finished_shard(5, returncode=1)
        self.assertEqual(MODULE.shard_problem(shard, result_line(5)), "exited with an error")

    def test_timeout_is_reported_first(self) -> None:
        shard = finished_shard(5)
        shard.timed_out = True
        self.assertIn("timed out", MODULE.shard_problem(shard, result_line(5)))


class FailureExcerptTests(unittest.TestCase):
    def test_starts_at_the_harness_failure_report(self) -> None:
        log_text = "\n".join(["noise", "failures:", "", "---- a stdout ----", "boom"])
        self.assertEqual(
            MODULE.failure_excerpt(log_text), "failures:\n\n---- a stdout ----\nboom"
        )

    def test_crash_shows_the_log_tail(self) -> None:
        lines = [f"line {index}" for index in range(1000)]
        excerpt = MODULE.failure_excerpt("\n".join(lines)).splitlines()
        self.assertEqual(len(excerpt), MODULE.FAILURE_TAIL_LINES)
        self.assertEqual(excerpt[-1], "line 999")


class StopShardsTests(unittest.TestCase):
    def test_stops_running_shards_and_skips_unstarted_ones(self) -> None:
        running = MODULE.Shard(0, [], Path("running.log"))
        running.process = subprocess.Popen(["sleep", "60"])
        not_started = MODULE.Shard(1, [], Path("not-started.log"))
        MODULE.stop_shards([running, not_started])
        self.assertEqual(running.process.returncode, -signal.SIGTERM)

    def test_signals_a_running_shard_exactly_once(self) -> None:
        shard = MODULE.Shard(0, [], Path("shard.log"))
        shard.process = mock.Mock()
        shard.process.poll.return_value = None
        MODULE.stop_shards([shard])
        shard.process.terminate.assert_called_once()


class FreePortTests(unittest.TestCase):
    def test_occupied_port_stops_the_run(self) -> None:
        with socket.socket() as listener:
            listener.bind((MODULE.SERVICE_HOST, 0))
            listener.listen()
            port = listener.getsockname()[1]
            with self.assertRaisesRegex(RuntimeError, "already in use"):
                MODULE.require_free_port(port, "Redis")
        MODULE.require_free_port(port, "Redis")


class ReportTests(unittest.TestCase):
    def report_with(self, tmp_log: Path, log_text: str, listed_count: int) -> bool:
        tmp_log.write_text(log_text)
        shard = finished_shard(1)
        shard.log = tmp_log
        with mock.patch("builtins.print"):
            return MODULE.report([shard], listed_count)

    def test_unaccounted_tests_fail_the_run(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "shard.log"
            self.assertTrue(self.report_with(log, result_line(1), 1))
            self.assertFalse(self.report_with(log, result_line(1), 2))


if __name__ == "__main__":
    unittest.main()
