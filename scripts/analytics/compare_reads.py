#!/usr/bin/env python3
"""Bounded, read-only PostgreSQL/gateway comparisons; writes evidence locally."""
import argparse
import datetime
import json
from pathlib import Path
import shlex
import subprocess
import time


def query(host, database, sql, tag=None):
    settings = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='15s';"
    if tag:
        settings += "SET LOCAL pg_clickhouse.session_settings = 'join_use_nulls 1, group_by_use_nulls 1, final 1, log_comment " + tag + "';"
    command = "sudo -n -u postgres psql -X -qAt -v ON_ERROR_STOP=1 -d " + shlex.quote(database)
    started = time.monotonic()
    result = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, command],
        input=settings + sql + ";ROLLBACK;", text=True, capture_output=True, timeout=50,
    )
    return {"ok": result.returncode == 0, "seconds": time.monotonic() - started,
            "output": result.stdout.strip(), "error": result.stderr.strip()}


def json_query(host, database, sql):
    result = query(host, database, sql)
    if not result["ok"]:
        raise RuntimeError(result["error"])
    return json.loads(result["output"])


def fingerprint_sql(low, high):
    tables = {
        "messages": ("signal_message", "id", "id, deleted, timestamp, created_at"),
        "inbox": ("sigint_inbox_item", "id", "id, datetime, freq, unit_v2"),
        "links": ("sigint_inbox_item_unit", "item_id", "item_id, unit_id, kind"),
        "media": ("signal_message_media", "signal_message_id", "id, signal_message_id"),
        "groups": ("signal_message_group", "signal_message_id", "signal_message_id, group_master_key"),
    }
    parts = []
    for name, (table, key, columns) in tables.items():
        parts.append(f"SELECT '{name}' AS input, count(*) AS rows, md5(coalesce(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text), '')) AS fingerprint FROM (SELECT {columns} FROM {table} WHERE {key} BETWEEN {low} AND {high}) t")
    parts.append(f"SELECT 'units', count(*), md5(coalesce(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text), '')) FROM (SELECT id, deleted FROM sigint_unit WHERE id IN (SELECT unit_id FROM sigint_inbox_item_unit WHERE item_id BETWEEN {low} AND {high})) t")
    parts.append(f"SELECT 'group_catalog', count(*), md5(coalesce(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text), '')) FROM (SELECT master_key, deleted FROM signal_group WHERE master_key IN (SELECT group_master_key FROM signal_message_group WHERE signal_message_id BETWEEN {low} AND {high})) t")
    return "SELECT json_agg(t) FROM (" + " UNION ALL ".join(parts) + ") t"


def comparisons(low, high, unit_id):
    base = f"FROM signal_message m JOIN sigint_inbox_item i ON i.id=m.id WHERE m.id BETWEEN {low} AND {high} AND i.id BETWEEN {low} AND {high} AND NOT m.deleted"
    unit = f"EXISTS (SELECT 1 FROM sigint_inbox_item_unit l JOIN sigint_unit u ON u.id=l.unit_id WHERE l.item_id=i.id AND l.unit_id={unit_id} AND NOT u.deleted{{bound}})"
    media = "EXISTS (SELECT 1 FROM signal_message_media a WHERE a.signal_message_id=m.id{bound})"
    for bounded in [False, True]:
        unit_filter = unit.format(bound=f" AND l.item_id BETWEEN {low} AND {high}" if bounded else "")
        media_filter = media.format(bound=f" AND a.signal_message_id BETWEEN {low} AND {high}" if bounded else "")
        suffix = "revised" if bounded else "original"
        yield "unit_count", suffix, "SELECT count(*) " + base + " AND " + unit_filter
        yield "unit_exclusion", suffix, "SELECT count(*) " + base + " AND NOT " + unit_filter
        yield "media_count", suffix, "SELECT count(*) " + base + " AND " + media_filter
        yield "unit_media_count", suffix, "SELECT count(*) " + base + " AND " + unit_filter + " AND " + media_filter
        yield "frequency_facet", suffix, "SELECT i.freq,count(*) " + base + " AND " + unit_filter + " GROUP BY i.freq ORDER BY i.freq"
        yield "candidates", suffix, "SELECT m.id,i.datetime " + base + " AND " + media_filter + " ORDER BY i.datetime DESC,m.id DESC LIMIT 20"
        group_bound = f" AND g.signal_message_id BETWEEN {low} AND {high}" if bounded else ""
        yield "group_activity", suffix, f"SELECT g.group_master_key,count(*) FILTER(WHERE m.timestamp >= TIMESTAMP '2026-09-03') AS recent_count,count(*) AS total_count FROM signal_message_group g JOIN signal_message m ON m.id=g.signal_message_id JOIN sigint_inbox_item i ON i.id=m.id JOIN signal_group sg ON sg.master_key=g.group_master_key WHERE m.id BETWEEN {low} AND {high} AND i.id BETWEEN {low} AND {high} AND NOT sg.deleted{group_bound} GROUP BY g.group_master_key ORDER BY g.group_master_key"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--gateway", required=True)
    parser.add_argument("--low", type=int, required=True)
    parser.add_argument("--high", type=int, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=1, choices=range(1, 4))
    parser.add_argument("--only", action="append", help="compare only the named query")
    args = parser.parse_args()
    if args.high < args.low or args.high - args.low > 10_000:
        parser.error("the sample must cover at most 10,001 message IDs")
    if not args.source.endswith("-dev") and args.repeats != 1:
        parser.error("production comparisons allow one execution only")
    args.out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d_%H%M%S")
    tag = "echo_analytics_verify_" + stamp
    unit_id = json_query(args.source, "wd", f"SELECT to_json(coalesce((SELECT unit_id FROM sigint_inbox_item_unit WHERE item_id BETWEEN {args.low} AND {args.high} GROUP BY unit_id ORDER BY count(*) DESC,unit_id LIMIT 1),0))")
    evidence = {"captured_at": stamp, "source": args.source, "gateway": args.gateway,
                "low": args.low, "high": args.high, "unit_id": unit_id, "log_comment": tag, "runs": []}
    fingerprints = fingerprint_sql(args.low, args.high)
    for role, host, database in [("source", args.source, "wd"), ("gateway", args.gateway, "echo_analytics_gateway")]:
        evidence[role + "_version"] = query(host, database, "SELECT version()")
        evidence[role + "_fingerprints_before"] = query(host, database, fingerprints)
        for name, variant, sql in comparisons(args.low, args.high, unit_id):
            if args.only and name not in args.only:
                continue
            run = {"role": role, "name": name, "variant": variant, "sql": sql}
            run["explain"] = query(host, database, "EXPLAIN (VERBOSE,COSTS OFF,FORMAT JSON) " + sql, tag if role == "gateway" else None)
            run["results"] = query(host, database, "SELECT coalesce(json_agg(t),'[]'::json) FROM (" + sql + ") t", tag if role == "gateway" else None)
            run["statistics"] = [query(host, database, "EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,SUMMARY ON,VERBOSE,FORMAT JSON) " + sql, tag if role == "gateway" else None) for _ in range(args.repeats)]
            evidence["runs"].append(run)
            (args.out / "comparison.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
        evidence[role + "_fingerprints_after"] = query(host, database, fingerprints)
    (args.out / "comparison.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(args.out / "comparison.json", flush=True)


if __name__ == "__main__":
    main()
