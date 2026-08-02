from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("check_analytics_migrations.py")
SPEC = importlib.util.spec_from_file_location("check_analytics_migrations", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class AnalyticsMigrationCheckTests(unittest.TestCase):
    def test_detects_unqualified_table_ddl(self) -> None:
        changes = MODULE.detect_ddl("alter table sample add column enabled boolean;")
        self.assertEqual(
            changes,
            [MODULE.DdlChange(operation="alter", table="public.sample")],
        )

    def test_excluded_strategy_requires_canonical_exclusion(self) -> None:
        errors = MODULE.validate_change(
            "echo:m1",
            "create table sample (id bigint);",
            [MODULE.DdlChange(operation="create", table="public.sample")],
            {"changes": [{"table": "public.sample", "strategy": "excluded"}]},
            set(),
        )
        self.assertIn("is not in canonical exclusions", errors[0])

    def test_cdc_backfill_requires_dml(self) -> None:
        contents = "alter table sample add column enabled boolean default false;"
        errors = MODULE.validate_change(
            "echo:m1",
            contents,
            MODULE.detect_ddl(contents),
            {"changes": [{"table": "public.sample", "strategy": "cdc_backfill"}]},
            set(),
        )
        self.assertTrue(any("without post-DDL DML" in error for error in errors))

    def test_cdc_backfill_accepts_update(self) -> None:
        contents = """
alter table sample add column enabled boolean default false;
update sample set enabled = false;
"""
        errors = MODULE.validate_change(
            "echo:m1",
            contents,
            MODULE.detect_ddl(contents),
            {"changes": [{"table": "public.sample", "strategy": "cdc_backfill"}]},
            set(),
        )
        self.assertEqual(errors, [])

    def test_catalog_comparison_returns_changed_tables(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            before = Path(directory) / "before.tsv"
            after = Path(directory) / "after.tsv"
            before.write_text("public.sample\tid\tbigint\tt\t\n")
            after.write_text(
                "public.sample\tid\tbigint\tt\t\n"
                "public.sample\tenabled\tboolean\tt\tfalse\n"
            )

            self.assertEqual(
                MODULE.snapshot_changed_tables(before, after),
                {"public.sample"},
            )


if __name__ == "__main__":
    unittest.main()
