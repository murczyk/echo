#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = REPO_ROOT / "deploy/clickhouse/migration-impact.json"
EXCLUSIONS_PATH = REPO_ROOT / "deploy/clickhouse/env/tables-exclude.txt"
MIGRATION_PATH_RE = re.compile(r"^echo-migration/src/(m[0-9a-z_]+)\.rs$")
DDL_RE = re.compile(
    r"\b(?P<operation>create|alter|drop)\s+table\s+"
    r"(?:if\s+(?:not\s+)?exists\s+)?"
    r"(?P<table>(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*)",
    re.IGNORECASE,
)
STRATEGIES = {
    "excluded",
    "replicated_snapshot",
    "cdc_backfill",
    "empty_table_resnapshot",
    "mirror_resync",
}
CDC_BACKFILL_GUARANTEED_NONEMPTY_TABLES = {"public.system_settings"}
DEPENDENCIES = {
    "echo-im": "echo-im",
    "echo-gpu": "echo-gpu-client",
}


@dataclass(frozen=True)
class DdlChange:
    operation: str
    table: str


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def default_base() -> str:
    base_ref = os.environ.get("GITHUB_BASE_REF")
    if base_ref:
        return f"origin/{base_ref}"
    return "HEAD^"


def changed_paths(base: str) -> list[str]:
    output = git("diff", "--name-only", "--diff-filter=AM", f"{base}...HEAD")
    return [line for line in output.splitlines() if line]


def merge_base(base: str) -> str:
    return git("merge-base", base, "HEAD").strip()


def changed_migrations(base: str) -> list[tuple[str, str, list[DdlChange]]]:
    migrations: list[tuple[str, str, list[DdlChange]]] = []
    for path in changed_paths(base):
        match = MIGRATION_PATH_RE.match(path)
        if match is None:
            continue
        contents = (REPO_ROOT / path).read_text()
        migrations.append(
            (f"echo:{match.group(1)}", contents, detect_ddl(contents))
        )
    return migrations


def parse_exclusions(contents: str) -> set[str]:
    exclusions: set[str] = set()
    for number, line in enumerate(contents.splitlines(), start=1):
        table = line.split("#", 1)[0].strip()
        if not table:
            continue
        if not re.fullmatch(r"[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*", table):
            raise ValueError(f"invalid exclusion at line {number}: {table}")
        exclusions.add(table)
    return exclusions


def detect_ddl(contents: str) -> list[DdlChange]:
    changes: list[DdlChange] = []
    for match in DDL_RE.finditer(contents):
        table = match.group("table").lower()
        if "." not in table:
            table = f"public.{table}"
        changes.append(DdlChange(match.group("operation").lower(), table))
    return changes


def has_add_column(contents: str, table: str) -> bool:
    schema, relation = table.split(".", 1)
    if schema == "public":
        qualified_table = rf"(?:public\s*\.\s*)?{re.escape(relation)}"
    else:
        qualified_table = rf"{re.escape(schema)}\s*\.\s*{re.escape(relation)}"
    return re.search(
        rf"\balter\s+table\s+(?:if\s+exists\s+)?{qualified_table}\b"
        rf"[^;]*\badd\s+column\b",
        contents,
        re.IGNORECASE | re.DOTALL,
    ) is not None


def load_manifest() -> dict[str, Any]:
    manifest = json.loads(MANIFEST_PATH.read_text())
    if set(manifest) != {"migrations", "dependencies"}:
        raise ValueError("migration impact manifest must contain migrations and dependencies")
    return manifest


def validate_change(
    key: str,
    contents: str,
    detected: list[DdlChange],
    declaration: dict[str, Any] | None,
    exclusions: set[str],
) -> list[str]:
    if not detected:
        return []
    if declaration is None:
        return [f"{key}: missing analytics migration impact declaration"]

    errors: list[str] = []
    declared_changes = declaration.get("changes")
    if not isinstance(declared_changes, list):
        return [f"{key}: declaration must contain a changes list"]

    declared_tables: set[str] = set()
    for change in declared_changes:
        if not isinstance(change, dict):
            errors.append(f"{key}: every declared change must be an object")
            continue
        table = change.get("table")
        strategy = change.get("strategy")
        if not isinstance(table, str) or not re.fullmatch(
            r"[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*", table
        ):
            errors.append(f"{key}: invalid declared table {table!r}")
            continue
        declared_tables.add(table)
        if strategy not in STRATEGIES:
            errors.append(f"{key}: invalid strategy for {table}: {strategy!r}")
            continue
        operations = {item.operation for item in detected if item.table == table}
        if strategy == "excluded" and table not in exclusions:
            errors.append(f"{key}: {table} uses excluded but is not in canonical exclusions")
        if strategy == "replicated_snapshot" and "create" not in operations:
            errors.append(f"{key}: {table} uses replicated_snapshot without CREATE TABLE")
        if strategy == "cdc_backfill":
            if "alter" not in operations or not has_add_column(contents, table):
                errors.append(f"{key}: {table} uses cdc_backfill without ADD COLUMN")
            if table not in CDC_BACKFILL_GUARANTEED_NONEMPTY_TABLES:
                errors.append(
                    f"{key}: {table} uses cdc_backfill but may be empty; "
                    "use mirror_resync because zero-row DML cannot propagate "
                    "the schema to ClickHouse"
                )
            relation = re.escape(table.split(".", 1)[1])
            dml = re.compile(
                rf"\b(?:update|insert\s+into|delete\s+from)\s+(?:public\.)?{relation}\b",
                re.IGNORECASE,
            )
            backfill_dml, backfill_errors = validate_backfill(change, table)
            errors.extend(f"{key}: {error}" for error in backfill_errors)
            if not dml.search(contents) and not backfill_dml:
                errors.append(
                    f"{key}: {table} uses cdc_backfill without reviewed backfill DML"
                )
        if strategy == "empty_table_resnapshot":
            if "alter" not in operations or not has_add_column(contents, table):
                errors.append(
                    f"{key}: {table} uses empty_table_resnapshot without ADD COLUMN"
                )

    detected_tables = {change.table for change in detected}
    if detected_tables != declared_tables:
        missing = sorted(detected_tables - declared_tables)
        unexpected = sorted(declared_tables - detected_tables)
        errors.append(
            f"{key}: declared tables differ from detected DDL "
            f"(missing={missing}, unexpected={unexpected})"
        )
    return errors


def validate_backfill(change: dict[str, Any], table: str) -> tuple[bool, list[str]]:
    backfill = change.get("backfill")
    if backfill is None:
        return False, []
    if not isinstance(backfill, str) or not backfill:
        return False, [f"{table} has an invalid backfill path"]

    backfill_path = (REPO_ROOT / backfill).resolve()
    try:
        backfill_path.relative_to(REPO_ROOT.resolve())
    except ValueError:
        return False, [f"{table} backfill path escapes the repository: {backfill}"]
    if not backfill_path.is_file():
        return False, [f"{table} backfill path does not exist: {backfill}"]

    contents = backfill_path.read_text()
    relation = re.escape(table.split(".", 1)[1])
    sql_dml = re.compile(
        rf"\b(?:update|insert\s+into|delete\s+from)\s+(?:public\.)?{relation}\b",
        re.IGNORECASE,
    )
    orm_dml = re.compile(
        rf"\b{relation}::Entity::(?:update_many|insert_many|delete_many)\s*\("
    )
    if not sql_dml.search(contents) and not orm_dml.search(contents):
        return False, [f"{table} backfill file has no recognized DML: {backfill}"]
    return True, []


def cargo_toml_at(revision: str) -> str:
    return git("show", f"{revision}:wdintel-rs/Cargo.toml")


def dependency_revisions(cargo_toml: str) -> dict[str, str]:
    revisions: dict[str, str] = {}
    for manifest_name, dependency_name in DEPENDENCIES.items():
        dependency = re.search(
            rf"^\[dependencies\.{re.escape(dependency_name)}\]\s*$"
            rf"(?P<body>.*?)(?=^\[|\Z)",
            cargo_toml,
            re.MULTILINE | re.DOTALL,
        )
        if dependency is None:
            continue
        revision = re.search(
            r'^rev\s*=\s*"(?P<revision>[0-9a-f]+)"\s*$',
            dependency.group("body"),
            re.MULTILINE,
        )
        if revision is not None:
            revisions[manifest_name] = revision.group("revision")
    return revisions


def validate_dependency_changes(
    base: str, manifest: dict[str, Any], exclusions: set[str]
) -> tuple[list[str], list[str]]:
    base_revisions = dependency_revisions(cargo_toml_at(merge_base(base)))
    head_revisions = dependency_revisions(
        (REPO_ROOT / "wdintel-rs/Cargo.toml").read_text()
    )
    declarations = manifest["dependencies"]
    errors: list[str] = []
    changed_keys: list[str] = []
    for name, revision in head_revisions.items():
        if base_revisions.get(name) == revision:
            continue
        key = f"{name}:{revision}"
        changed_keys.append(key)
        declaration = declarations.get(key)
        if not isinstance(declaration, dict) or not isinstance(
            declaration.get("changes"), list
        ):
            errors.append(
                f"{key}: dependency revision changed without an analytics impact declaration"
            )
            continue
        for change in declaration["changes"]:
            if not isinstance(change, dict):
                errors.append(f"{key}: every declared change must be an object")
                continue
            table = change.get("table")
            strategy = change.get("strategy")
            if not isinstance(table, str) or not re.fullmatch(
                r"[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*", table
            ):
                errors.append(f"{key}: invalid declared table {table!r}")
            if strategy not in STRATEGIES:
                errors.append(f"{key}: invalid strategy for {table}: {strategy!r}")
            if strategy == "excluded" and table not in exclusions:
                errors.append(
                    f"{key}: {table} uses excluded but is not in canonical exclusions"
                )
            if (
                strategy == "cdc_backfill"
                and table not in CDC_BACKFILL_GUARANTEED_NONEMPTY_TABLES
            ):
                errors.append(
                    f"{key}: {table} uses cdc_backfill but may be empty; "
                    "use mirror_resync because zero-row DML cannot propagate "
                    "the schema to ClickHouse"
                )
            if strategy == "empty_table_resnapshot":
                errors.append(
                    f"{key}: {table} uses empty_table_resnapshot in a dependency "
                    "declaration where additive DDL cannot be verified"
                )
    return errors, changed_keys


def snapshot_changed_tables(before_path: Path, after_path: Path) -> set[str]:
    before = set(before_path.read_text().splitlines())
    after = set(after_path.read_text().splitlines())
    tables: set[str] = set()
    for line in before.symmetric_difference(after):
        table, separator, _ = line.partition("\t")
        if not separator:
            raise ValueError(f"invalid schema snapshot row: {line!r}")
        tables.add(table)
    return tables


def declared_tables(
    manifest: dict[str, Any], migration_keys: list[str], dependency_keys: list[str]
) -> set[str]:
    tables: set[str] = set()
    for section, keys in (
        (manifest["migrations"], migration_keys),
        (manifest["dependencies"], dependency_keys),
    ):
        for key in keys:
            declaration = section.get(key)
            if not isinstance(declaration, dict):
                continue
            for change in declaration.get("changes", []):
                if isinstance(change, dict) and isinstance(change.get("table"), str):
                    tables.add(change["table"])
    return tables


def catalog_differences(
    actual: set[str],
    declared: set[str],
    migrations: list[tuple[str, str, list[DdlChange]]],
) -> tuple[set[str], set[str]]:
    operations_by_table: dict[str, set[str]] = {}
    for _, _, changes in migrations:
        for change in changes:
            operations_by_table.setdefault(change.table, set()).add(change.operation)
    created_and_dropped = {
        table
        for table, operations in operations_by_table.items()
        if {"create", "drop"} <= operations
    }
    return actual - declared, declared - actual - created_and_dropped


def check(
    base: str, catalog_before: Path | None = None, catalog_after: Path | None = None
) -> list[str]:
    manifest = load_manifest()
    exclusions = parse_exclusions(EXCLUSIONS_PATH.read_text())
    errors: list[str] = []
    migrations = changed_migrations(base)
    for key, contents, ddl in migrations:
        errors.extend(
            validate_change(
                key,
                contents,
                ddl,
                manifest["migrations"].get(key),
                exclusions,
            )
        )
    dependency_errors, dependency_keys = validate_dependency_changes(
        base, manifest, exclusions
    )
    errors.extend(dependency_errors)
    if (catalog_before is None) != (catalog_after is None):
        errors.append("both catalog snapshots must be supplied together")
    elif catalog_before is not None and catalog_after is not None:
        actual = snapshot_changed_tables(catalog_before, catalog_after)
        declared = declared_tables(
            manifest, [key for key, _, _ in migrations], dependency_keys
        )
        undeclared, unchanged_but_declared = catalog_differences(
            actual, declared, migrations
        )
        if undeclared or unchanged_but_declared:
            errors.append(
                "database catalog changes differ from the analytics impact manifest "
                f"(undeclared={sorted(undeclared)}, "
                f"unchanged_but_declared={sorted(unchanged_but_declared)})"
            )
    return errors


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Require an explicit ClickHouse strategy for migration DDL"
    )
    parser.add_argument("--base", default=default_base())
    parser.add_argument("--catalog-before", type=Path)
    parser.add_argument("--catalog-after", type=Path)
    args = parser.parse_args()

    try:
        errors = check(args.base, args.catalog_before, args.catalog_after)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"analytics migration check failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    if errors:
        print("Analytics migration policy violations:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        raise SystemExit(1)
    print("Analytics migration policy check passed")


if __name__ == "__main__":
    main()
