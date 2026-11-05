#!/usr/bin/env python3
"""Fail when a Rust test wipes the test database without #[serial].

CI runs tests in parallel shards, so a wipe without #[serial] can truncate
tables under a running test. That shows up as a rare failure in an unrelated
test, which is why it is rejected here instead of being left to chance.
"""

import re
import sys
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[2] / "wdintel-rs" / "src"
# Defining these does not count as using them.
IGNORED_FILES = ("functest.rs",)

ITEM = re.compile(
    r"((?:^[ \t]*#\[[^\n]*\][ \t]*\n)*)"
    r"^[ \t]*(?:pub(?:\([a-z]+\))? )?(?:async )?fn ([a-z_0-9]+)\s*[(<]",
    re.MULTILINE,
)
TEST_ATTRIBUTE = re.compile(r"#\[(?:tokio|actix_web|actix_rt)?(?:::)?test\b")
WIPE_CALL = re.compile(r"\bcleanup(?:_locked)?\(\)")


def unserialized_wipers(source):
    """Return test names that reach a wipe, directly or through a local helper."""
    items = list(ITEM.finditer(source))
    bodies = [
        (item, source[item.end() : following])
        for item, following in zip(items, [*(i.start() for i in items[1:]), len(source)])
    ]
    helpers = {
        item.group(2)
        for item, body in bodies
        if not TEST_ATTRIBUTE.search(item.group(1)) and WIPE_CALL.search(body)
    }
    wipe = WIPE_CALL.pattern
    if helpers:
        wipe += r"|\b(?:" + "|".join(sorted(helpers)) + r")\("
    return [
        item.group(2)
        for item, body in bodies
        if TEST_ATTRIBUTE.search(item.group(1))
        and "serial" not in item.group(1)
        and "#[ignore" not in item.group(1)
        and re.search(wipe, body)
    ]


def main():
    problems = [
        f"{path.relative_to(SOURCE_ROOT.parents[1])}: {name}"
        for path in sorted(SOURCE_ROOT.rglob("*.rs"))
        if path.name not in IGNORED_FILES
        for name in unserialized_wipers(path.read_text(encoding="utf-8"))
    ]
    if problems:
        print("These tests wipe the database, so they need #[serial]:")
        print("\n".join(f"  {problem}" for problem in problems))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
