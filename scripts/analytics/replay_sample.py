#!/usr/bin/env python3
"""Replay a bounded dev sample in an isolated PostgreSQL/ClickHouse installation."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

from compare_reads import comparisons, json_query


def postgres(sql):
    result = subprocess.run(
        ["psql", "-X", "-qAt", "-h", "/tmp", "-p", "55432", "-d", "postgres",
         "-v", "ON_ERROR_STOP=1"], input="SET statement_timeout='15s';" + sql,
        text=True, capture_output=True, timeout=30,
    )
    return {"ok": result.returncode == 0, "output": result.stdout.strip(), "error": result.stderr.strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--low", required=True, type=int)
    parser.add_argument("--high", required=True, type=int)
    parser.add_argument("--runtime", required=True, type=Path)
    parser.add_argument("--baseline", required=True, type=Path)
    parser.add_argument("--revised", required=True, type=Path)
    parser.add_argument("--clickhouse", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    if not args.source.endswith("-dev") or not 0 <= args.high - args.low <= 10_000:
        parser.error("use a dev source and at most 10,001 message IDs")
    args.out.mkdir(parents=True, exist_ok=True)
    tables = {
        "signal_message": ("id", "id Int64, deleted Bool, timestamp Nullable(DateTime64(6)), created_at DateTime64(6)"),
        "sigint_inbox_item": ("id", "id Int64, datetime Nullable(DateTime64(6)), freq Nullable(String), unit_v2 Nullable(String)"),
        "sigint_inbox_item_unit": ("item_id", "item_id Int64, unit_id Int64, kind String"),
        "signal_message_media": ("signal_message_id", "id UUID, signal_message_id Int64"),
        "signal_message_group": ("signal_message_id", "signal_message_id Int64, group_master_key Nullable(String)"),
        "sigint_unit": ("", "id Int64, deleted Bool"),
        "signal_group": ("", "master_key String, deleted Bool"),
    }
    sample = {}
    for table, (key, definition) in tables.items():
        columns = ",".join(column.split()[0] for column in definition.split(", "))
        predicate = f"{key} BETWEEN {args.low} AND {args.high}"
        if table == "sigint_unit":
            predicate = f"id IN (SELECT unit_id FROM sigint_inbox_item_unit WHERE item_id BETWEEN {args.low} AND {args.high})"
        if table == "signal_group":
            predicate = f"master_key IN (SELECT group_master_key FROM signal_message_group WHERE signal_message_id BETWEEN {args.low} AND {args.high})"
        sample[table] = json_query(args.source, "wd", f"SELECT coalesce(json_agg(t),'[]'::json) FROM (SELECT {columns} FROM {table} WHERE {predicate}) t")
    (args.out / "sample.json").write_text(json.dumps(sample, ensure_ascii=False) + "\n")

    def clickhouse(sql, data=None):
        return subprocess.run([str(args.clickhouse), "client", "--host", "127.0.0.1", "--max_execution_time", "15", "--query", sql],
                              input=data, text=True, capture_output=True, check=True, timeout=30).stdout

    clickhouse("DROP DATABASE IF EXISTS echo_analytics_sample")
    clickhouse("CREATE DATABASE echo_analytics_sample")
    for table, (_, definition) in tables.items():
        clickhouse(f"CREATE TABLE echo_analytics_sample.{table} ({definition}) ENGINE=MergeTree ORDER BY tuple()")
        if sample[table]:
            clickhouse(f"INSERT INTO echo_analytics_sample.{table} SETTINGS date_time_input_format='best_effort' FORMAT JSONEachRow",
                       "\n".join(json.dumps(row, ensure_ascii=False) for row in sample[table]))
    setup = postgres("""
        CREATE EXTENSION IF NOT EXISTS pg_clickhouse;
        DROP SCHEMA IF EXISTS analytics_sample_remote CASCADE;
        DROP SCHEMA IF EXISTS analytics_sample_local CASCADE;
        DROP SERVER IF EXISTS analytics_sample CASCADE;
        CREATE SERVER analytics_sample FOREIGN DATA WRAPPER clickhouse_fdw OPTIONS(dbname 'echo_analytics_sample',driver 'binary');
        CREATE USER MAPPING FOR CURRENT_USER SERVER analytics_sample;
        CREATE SCHEMA analytics_sample_remote;
        IMPORT FOREIGN SCHEMA echo_analytics_sample FROM SERVER analytics_sample INTO analytics_sample_remote;
        CREATE SCHEMA analytics_sample_local;
    """ + "".join(f"CREATE TABLE analytics_sample_local.{table} AS TABLE analytics_sample_remote.{table};" for table in tables))
    if not setup["ok"]:
        raise RuntimeError(setup["error"])
    media_ids = {row["signal_message_id"] for row in sample["signal_message_media"]}
    counts = Counter(row["unit_id"] for row in sample["sigint_inbox_item_unit"] if row["item_id"] in media_ids)
    unit_id = counts.most_common(1)[0][0]
    evidence = {"source": args.source, "low": args.low, "high": args.high, "unit_id": unit_id,
                "sample_sha256": hashlib.sha256((args.out / "sample.json").read_bytes()).hexdigest(),
                "rows": {name: len(rows) for name, rows in sample.items()}, "runs": []}
    library = args.runtime / "pg/lib/postgresql/18/lib/pg_clickhouse.so"
    try:
        for version, build in [("baseline", args.baseline), ("revised", args.revised)]:
            replacement = library.with_name("pg_clickhouse-next.so")
            shutil.copyfile(build, replacement)
            replacement.replace(library)
            for driver in ["binary", "http"]:
                postgres(f"ALTER SERVER analytics_sample OPTIONS(SET driver '{driver}');")
                for name, variant, sql in comparisons(args.low, args.high, unit_id):
                    tag = f"sample_{version}_{driver}_{name}_{variant}"
                    settings = f"SET search_path=analytics_sample_remote,public; SET pg_clickhouse.session_settings='join_use_nulls 1,group_by_use_nulls 1,final 1,log_comment {tag}';"
                    wrapped = "SELECT coalesce(json_agg(t),'[]'::json) FROM (" + sql + ") t;"
                    expected = postgres("SET search_path=analytics_sample_local,public;" + wrapped)
                    actual = postgres(settings + wrapped)
                    plans = [postgres(settings + "EXPLAIN (ANALYZE,BUFFERS,VERBOSE,FORMAT JSON) " + sql) for _ in range(3)]
                    evidence["runs"].append({"version": version, "driver": driver, "name": name, "variant": variant,
                                             "sql": sql, "log_comment": tag, "expected": expected, "actual": actual, "plans": plans})
                    (args.out / "comparison.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    finally:
        replacement = library.with_name("pg_clickhouse-next.so")
        shutil.copyfile(args.revised, replacement)
        replacement.replace(library)
    clickhouse("SYSTEM FLUSH LOGS")
    logs = clickhouse("SELECT log_comment, query_id, query_duration_ms, read_rows, result_rows, exception_code, query FROM system.query_log WHERE startsWith(log_comment,'sample_') AND type IN ('QueryFinish','ExceptionWhileProcessing') ORDER BY event_time_microseconds FORMAT JSONEachRow")
    (args.out / "clickhouse.jsonl").write_text(logs)
    print(args.out / "comparison.json")


if __name__ == "__main__":
    main()
