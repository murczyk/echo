from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).with_name("check_analytics_migrations.py")
SPEC = importlib.util.spec_from_file_location("check_analytics_migrations", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class AnalyticsMigrationCheckTests(unittest.TestCase):
    def test_changed_paths_include_staged_files(self) -> None:
        outputs = {
            ("diff", "--name-only", "--diff-filter=AM", "base"): "committed.rs\n",
            ("diff", "--name-only", "--diff-filter=AM"): "worktree.rs\n",
            ("diff", "--cached", "--name-only", "--diff-filter=AM"): "staged.rs\n",
            ("ls-files", "--others", "--exclude-standard"): "untracked.rs\n",
        }
        with (
            mock.patch.object(MODULE, "merge_base", return_value="base"),
            mock.patch.object(
                MODULE, "git", side_effect=lambda *args: outputs[args]
            ),
        ):
            self.assertEqual(
                MODULE.changed_paths("origin/main"),
                ["committed.rs", "staged.rs", "untracked.rs", "worktree.rs"],
            )

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
        self.assertTrue(
            any("without reviewed backfill DML" in error for error in errors)
        )

    def test_cdc_backfill_rejects_potentially_empty_table(self) -> None:
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
        self.assertTrue(any("may be empty" in error for error in errors))

    def test_cdc_backfill_accepts_guaranteed_nonempty_table(self) -> None:
        contents = """
alter table system_settings add column enabled boolean default false;
update system_settings set enabled = false;
"""
        errors = MODULE.validate_change(
            "echo:m1",
            contents,
            MODULE.detect_ddl(contents),
            {
                "changes": [
                    {
                        "table": "public.system_settings",
                        "strategy": "cdc_backfill",
                    }
                ]
            },
            set(),
        )
        self.assertEqual(errors, [])

    def test_cdc_backfill_accepts_rust_backfill(self) -> None:
        contents = "alter table sample add column enabled boolean default false;"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backfill = root / "backfill.rs"
            backfill.write_text("system_settings::Entity::update_many();")
            with mock.patch.object(MODULE, "REPO_ROOT", root):
                errors = MODULE.validate_change(
                    "echo:m1",
                    contents.replace("sample", "system_settings"),
                    MODULE.detect_ddl(contents.replace("sample", "system_settings")),
                    {
                        "changes": [
                            {
                                "table": "public.system_settings",
                                "strategy": "cdc_backfill",
                                "backfill": "backfill.rs",
                            }
                        ]
                    },
                    set(),
                )
        self.assertEqual(errors, [])

    def test_empty_table_resnapshot_accepts_add_column(self) -> None:
        contents = "alter table sample add column enabled boolean default false;"
        errors = MODULE.validate_change(
            "echo:m1",
            contents,
            MODULE.detect_ddl(contents),
            {
                "changes": [
                    {
                        "table": "public.sample",
                        "strategy": "empty_table_resnapshot",
                    }
                ]
            },
            set(),
        )
        self.assertEqual(errors, [])

    def test_empty_table_resnapshot_rejects_non_additive_change(self) -> None:
        contents = "alter table sample alter column enabled type text;"
        errors = MODULE.validate_change(
            "echo:m1",
            contents,
            MODULE.detect_ddl(contents),
            {
                "changes": [
                    {
                        "table": "public.sample",
                        "strategy": "empty_table_resnapshot",
                    }
                ]
            },
            set(),
        )
        self.assertTrue(any("without ADD COLUMN" in error for error in errors))

    def test_empty_table_resnapshot_requires_add_on_declared_table(self) -> None:
        contents = """
alter table sample alter column enabled type text;
alter table another add column enabled boolean;
"""
        errors = MODULE.validate_change(
            "echo:m1",
            contents,
            MODULE.detect_ddl(contents),
            {
                "changes": [
                    {
                        "table": "public.sample",
                        "strategy": "empty_table_resnapshot",
                    },
                    {
                        "table": "public.another",
                        "strategy": "mirror_resync",
                    },
                ]
            },
            set(),
        )
        self.assertTrue(any("without ADD COLUMN" in error for error in errors))

    def test_targeted_replicated_snapshot_accepts_add_column(self) -> None:
        contents = "alter table sample add column enabled boolean;"
        errors = MODULE.validate_change(
            "echo:m1",
            contents,
            MODULE.detect_ddl(contents),
            {
                "changes": [
                    {
                        "table": "public.sample",
                        "strategy": "replicated_snapshot",
                        "targeted_resnapshot": True,
                    }
                ]
            },
            set(),
        )
        self.assertEqual(errors, [])

    def test_dependency_targeted_snapshot_is_catalog_validated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest_dir = root / "wdintel-rs"
            manifest_dir.mkdir()
            (manifest_dir / "Cargo.toml").write_text(
                '[dependencies.echo-im]\nrev = "bbbb"\n'
            )
            manifest = {
                "dependencies": {
                    "echo-im:bbbb": {
                        "changes": [
                            {
                                "table": "public.echo_client",
                                "strategy": "replicated_snapshot",
                                "targeted_resnapshot": True,
                            }
                        ]
                    }
                }
            }
            with (
                mock.patch.object(MODULE, "REPO_ROOT", root),
                mock.patch.object(MODULE, "merge_base", return_value="base"),
                mock.patch.object(
                    MODULE,
                    "cargo_toml_at",
                    return_value='[dependencies.echo-im]\nrev = "aaaa"\n',
                ),
            ):
                errors, keys = MODULE.validate_dependency_changes(
                    "origin/main", manifest, set()
                )
        self.assertEqual(errors, [])
        self.assertEqual(keys, ["echo-im:bbbb"])

    def test_replicated_snapshot_rejects_alter_without_targeted_flag(
        self,
    ) -> None:
        contents = "alter table sample add column enabled boolean;"
        errors = MODULE.validate_change(
            "echo:m1",
            contents,
            MODULE.detect_ddl(contents),
            {
                "changes": [
                    {
                        "table": "public.sample",
                        "strategy": "replicated_snapshot",
                    }
                ]
            },
            set(),
        )
        self.assertTrue(any("without CREATE TABLE" in error for error in errors))

    def test_targeted_replicated_snapshot_rejects_non_additive_change(
        self,
    ) -> None:
        contents = "alter table sample alter column enabled type text;"
        errors = MODULE.validate_change(
            "echo:m1",
            contents,
            MODULE.detect_ddl(contents),
            {
                "changes": [
                    {
                        "table": "public.sample",
                        "strategy": "replicated_snapshot",
                        "targeted_resnapshot": True,
                    }
                ]
            },
            set(),
        )
        self.assertTrue(any("without ADD COLUMN" in error for error in errors))

    def test_targeted_replicated_snapshot_rejects_add_and_alter_column(
        self,
    ) -> None:
        contents = """
async fn up() {
    alter table sample add column enabled boolean;
    alter table sample alter column label type text;
}
async fn down() {
    alter table sample drop column enabled;
}
"""
        errors = MODULE.validate_change(
            "echo:m1",
            contents,
            MODULE.detect_ddl(contents),
            {
                "changes": [
                    {
                        "table": "public.sample",
                        "strategy": "replicated_snapshot",
                        "targeted_resnapshot": True,
                    }
                ]
            },
            set(),
        )
        self.assertTrue(any("without ADD COLUMN" in error for error in errors))

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

    def test_targeted_resnapshot_catalog_rejects_changed_existing_column(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            before = Path(directory) / "before.tsv"
            after = Path(directory) / "after.tsv"
            before.write_text("public.sample\tid\tbigint\tt\t\n")
            after.write_text(
                "public.sample\tid\tinteger\tt\t\n"
                "public.sample\tenabled\tboolean\tf\t\n"
            )

            self.assertEqual(
                MODULE.non_additive_catalog_tables(
                    before, after, {"public.sample"}
                ),
                {"public.sample"},
            )

    def test_nonempty_resnapshot_catalog_rejects_non_nullable_added_column(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            before = Path(directory) / "before.tsv"
            after = Path(directory) / "after.tsv"
            before.write_text("public.sample\tid\tbigint\tt\t\n")
            after.write_text(
                "public.sample\tid\tbigint\tt\t\n"
                "public.sample\tenabled\tboolean\tt\tfalse\n"
            )

            self.assertEqual(
                MODULE.non_nullable_added_catalog_tables(
                    before, after, {"public.sample"}
                ),
                {"public.sample"},
            )

    def test_catalog_comparison_allows_table_created_and_dropped_in_branch(
        self,
    ) -> None:
        migrations = [
            (
                "echo:m1",
                "",
                [MODULE.DdlChange(operation="create", table="public.transient")],
            ),
            (
                "echo:m2",
                "",
                [MODULE.DdlChange(operation="drop", table="public.transient")],
            ),
        ]

        self.assertEqual(
            MODULE.catalog_differences(set(), {"public.transient"}, migrations),
            (set(), set()),
        )

    def test_catalog_comparison_rejects_unchanged_altered_table(self) -> None:
        migrations = [
            (
                "echo:m1",
                "",
                [MODULE.DdlChange(operation="alter", table="public.sample")],
            )
        ]

        self.assertEqual(
            MODULE.catalog_differences(set(), {"public.sample"}, migrations),
            (set(), {"public.sample"}),
        )


if __name__ == "__main__":
    unittest.main()
