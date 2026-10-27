#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import runpy
from pathlib import Path

ALERTS = runpy.run_path(str(Path(__file__).with_name("install-nuextract-alert.py")))


def storage_rule(metric: str, op: str, warning: int, critical: int) -> dict:
    rule = ALERTS["alert_rule"]()
    rule["alert"] = f"OCR extractor {metric.replace('_', ' ')}"
    condition = rule["condition"]
    aggregation = condition["compositeQuery"]["queries"][0]["spec"]
    aggregation["aggregations"] = [
        {
            "metricName": f"echo_document_extractor_{metric}",
            "timeAggregation": "max" if op == "below" else "min",
            "spaceAggregation": "min" if op == "below" else "max",
        }
    ]
    aggregation["filter"]["expression"] = "service.instance.id = 'ct-echo-document-extractor/worker'"
    condition["alertOnAbsent"] = None
    condition["thresholds"]["spec"] = [
        {
            "name": severity,
            "target": target * 1024**3,
            "op": op,
            "matchType": "all_the_times",
            "channels": ["mattermost monitoring"],
        }
        for severity, target in (("warning", warning), ("critical", critical))
    ]
    rule["annotations"] = {
        "summary": f"OCR extractor {metric}: storage threshold sustained for five minutes",
        "description": (
            "Check extractor /v1/status, container free space and the echo-gpu ZFS pool. "
            "Preserve retained jobs and rollback backups. Follow "
            "echo-document-extractor/STORAGE_RECOVERY.md."
        ),
    }
    return rule


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    rules = [
        storage_rule("spool_bytes", "above", 160, 180),
        storage_rule("spool_free_bytes", "below", 40, 25),
    ]
    if args.apply:
        for rule in rules:
            ALERTS["install_rule"](rule)
    else:
        print(json.dumps(rules, indent=2))


if __name__ == "__main__":
    main()
