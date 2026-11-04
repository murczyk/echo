from __future__ import annotations

import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).with_name("ci_scope.py")
SPEC = importlib.util.spec_from_file_location("ci_scope", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


PULL_REQUEST_INTO_MAIN = {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_BASE_REF": "main"}


class PathRuleTests(unittest.TestCase):
    def test_frontend_and_docs_do_not_need_the_backend(self) -> None:
        paths = ["wdintel-web/src/Main.elm", "docs/README.md", "CHANGELOG.md"]
        self.assertFalse(MODULE.backend_required(paths))

    def test_paths_read_by_rust_need_the_backend(self) -> None:
        for path in ("wdintel-web/static/img/echo-logo-white.svg", "docs/echo-docs/src/main.rs"):
            self.assertTrue(MODULE.backend_required([path]), path)

    def test_unlisted_paths_need_the_backend(self) -> None:
        for path in (
            "Cargo.lock",
            "rust-toolchain.toml",
            "wdintel-rs/src/main.rs",
            "wdintel-rs/README.md",
            "echo-migration/src/lib.rs",
            "echo-ai-agent/versions.env",
            "ai-eval/2026-10-02-position-prompt/prompt.txt",
            "deploy/run_ci_tests.sh",
            "scripts/ci/ci_scope.py",
            ".github/workflows/run-tests.yml",
            '"wdintel-web/\\321\\204.txt"',
        ):
            self.assertTrue(MODULE.backend_required([path]), path)

    def test_one_backend_path_outweighs_frontend_paths(self) -> None:
        paths = ["wdintel-web/src/Main.elm", "wdintel-rs/src/main.rs"]
        self.assertTrue(MODULE.backend_required(paths))

    def test_clickhouse_suite_follows_its_own_inputs(self) -> None:
        self.assertTrue(MODULE.clickhouse_required(["deploy/clickhouse/bin/lib.sh"]))
        self.assertTrue(MODULE.clickhouse_required(["scripts/ci/ci_scope.py"]))
        self.assertFalse(MODULE.clickhouse_required(["wdintel-rs/src/main.rs"]))


class ChangedPathTests(unittest.TestCase):
    def test_only_pull_requests_into_main_can_skip(self) -> None:
        for environment in (
            {"GITHUB_EVENT_NAME": "push", "GITHUB_BASE_REF": ""},
            {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_BASE_REF": ""},
            {"GITHUB_EVENT_NAME": "pull_request", "GITHUB_BASE_REF": "stable"},
        ):
            with (
                mock.patch.dict(os.environ, environment),
                mock.patch.object(MODULE.subprocess, "run") as run,
            ):
                self.assertIsNone(MODULE.changed_paths(), environment)
                run.assert_not_called()

    def test_merge_commit_reports_the_pull_request_paths(self) -> None:
        with _merge_commit_checkout("wdintel-web/app.ts"), mock.patch.dict(
            os.environ, PULL_REQUEST_INTO_MAIN
        ):
            self.assertEqual(MODULE.changed_paths(), ["wdintel-web/app.ts"])

    def test_checkout_without_merge_parent_runs_everything(self) -> None:
        with _merge_commit_checkout("wdintel-web/app.ts"), mock.patch.dict(
            os.environ, PULL_REQUEST_INTO_MAIN
        ):
            _git("reset", "--hard", "--quiet", "HEAD^1")
            self.assertIsNone(MODULE.changed_paths())


class CommandLineTests(unittest.TestCase):
    def run_suite(self, suite: str, paths: list[str] | None) -> str:
        output = io.StringIO()
        with (
            mock.patch.object(MODULE, "changed_paths", return_value=paths),
            mock.patch.object(sys, "argv", ["ci_scope.py", suite]),
            redirect_stdout(output),
        ):
            MODULE.main()
        return output.getvalue().strip()

    def test_prints_skip_only_for_irrelevant_paths(self) -> None:
        self.assertEqual(self.run_suite("backend", ["docs/a.md"]), "skip")
        self.assertEqual(self.run_suite("backend", ["wdintel-rs/src/a.rs"]), "run")

    def test_unknown_paths_run_every_suite(self) -> None:
        self.assertEqual(self.run_suite("backend", None), "run")
        self.assertEqual(self.run_suite("clickhouse", None), "run")

    def test_failure_prints_nothing_for_callers_to_mistake_for_skip(self) -> None:
        script = subprocess.run(
            [sys.executable, str(SCRIPT_PATH), "unknown-suite"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(script.returncode, 0)
        self.assertEqual(script.stdout, "")


def _git(*args: str) -> None:
    subprocess.run(["git", *args], check=True, capture_output=True)


class _merge_commit_checkout:
    """Work inside a repository whose HEAD merges one changed path into main."""

    def __init__(self, changed_path: str) -> None:
        self.changed_path = changed_path

    def __enter__(self) -> None:
        self.original_directory = Path.cwd()
        self.directory = tempfile.TemporaryDirectory()
        os.chdir(self.directory.name)
        _git("init", "--quiet", "--initial-branch=main")
        _git("config", "user.name", "CI")
        _git("config", "user.email", "ci@example.invalid")
        _git("commit", "--allow-empty", "--quiet", "--message=base")
        _git("switch", "--quiet", "--create", "feature")
        path = Path(self.changed_path)
        path.parent.mkdir(parents=True)
        path.write_text("change\n")
        _git("add", ".")
        _git("commit", "--quiet", "--message=change")
        _git("switch", "--quiet", "main")
        _git("merge", "--no-ff", "--quiet", "--message=merge", "feature")

    def __exit__(self, *_exception: object) -> None:
        os.chdir(self.original_directory)
        self.directory.cleanup()


if __name__ == "__main__":
    unittest.main()
