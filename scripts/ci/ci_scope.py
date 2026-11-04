#!/usr/bin/env python3
"""Decide whether a CI suite can be skipped for a pull request.

Prints `skip` only when the changed paths cannot affect the suite, and `run`
otherwise. Callers must compare the output with `skip`, so a crash here runs
the suite instead of hiding it.
"""

import os
import subprocess
import sys

BACKEND_SKIPPABLE_PREFIXES = ("wdintel-web/", "docs/")
# Rust embeds these and reads them from tests, so they still need the backend.
BACKEND_REQUIRED_PREFIXES = ("wdintel-web/static/", "docs/echo-docs/")
CLICKHOUSE_PREFIXES = ("deploy/clickhouse/", "scripts/ci/")


def backend_required(paths):
    return any(_path_needs_backend(path) for path in paths)


def clickhouse_required(paths):
    return any(path.startswith(CLICKHOUSE_PREFIXES) for path in paths)


def _path_needs_backend(path):
    if path.startswith(BACKEND_REQUIRED_PREFIXES):
        return True
    if path.startswith(BACKEND_SKIPPABLE_PREFIXES):
        return False
    return not _is_root_markdown(path)


def _is_root_markdown(path):
    return "/" not in path and path.endswith(".md")


SUITES = {"backend": backend_required, "clickhouse": clickhouse_required}


def changed_paths():
    """Return the paths of a pull request into main, or None to run everything."""
    if os.environ.get("GITHUB_EVENT_NAME") != "pull_request":
        return None
    if os.environ.get("GITHUB_BASE_REF") != "main":
        return None
    # A pull_request checkout is the merge commit, so HEAD^1 is its target.
    has_merge_parent = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", "HEAD^2"],
        capture_output=True,
    )
    if has_merge_parent.returncode != 0:
        return None
    output = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", "HEAD^1", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return output.splitlines() or None


def main():
    required = SUITES[sys.argv[1]]
    paths = changed_paths()
    print("run" if paths is None or required(paths) else "skip")


if __name__ == "__main__":
    main()
