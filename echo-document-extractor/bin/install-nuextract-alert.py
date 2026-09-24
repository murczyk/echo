#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def alert_rule() -> dict:
    return {
        "alert": "OCR NuExtract dependency unavailable",
        "alertType": "METRIC_BASED_ALERT",
        "ruleType": "threshold_rule",
        "version": "v5",
        "schemaVersion": "v2alpha1",
        "disabled": False,
        "condition": {
            "compositeQuery": {
                "queryType": "builder",
                "panelType": "graph",
                "queries": [{
                    "type": "builder_query",
                    "spec": {
                        "name": "A",
                        "signal": "metrics",
                        "aggregations": [{
                            "metricName": "echo_document_extractor_dependency_up",
                            "timeAggregation": "max",
                            "spaceAggregation": "min",
                        }],
                        "filter": {"expression": (
                            "dependency = 'nuextract' AND "
                            "service.instance.id = 'ct-echo-document-extractor/worker'"
                        )},
                        "groupBy": [],
                    },
                }],
            },
            "selectedQueryName": "A",
            "alertOnAbsent": True,
            "absentFor": 5,
            "thresholds": {"kind": "basic", "spec": [{
                "name": "critical",
                "target": 0,
                "op": "equal",
                "matchType": "all_the_times",
                "channels": ["mattermost monitoring"],
            }]},
        },
        "evaluation": {"kind": "rolling", "spec": {"evalWindow": "5m0s", "frequency": "1m"}},
        "annotations": {
            "summary": "OCR is blocked: NuExtract is unavailable or its worker telemetry is missing",
            "description": (
                "Check the extractor /v1/status, the NuExtract router on port 8002, and "
                "echo-nuextract3 on Flyingskull. Compare host NVIDIA module and library versions. "
                "Follow echo-vllm-router/workers/nuextract/MAINTENANCE.md; preserve queued jobs."
            ),
        },
        "notificationSettings": {
            "groupBy": [],
            "usePolicy": False,
            "renotify": {"enabled": True, "interval": "30m", "alertStates": ["firing", "nodata"]},
        },
    }


def request(method: str, path: str, payload: dict | None = None) -> dict:
    headers = {"SIGNOZ-API-KEY": os.environ["SIGNOZ_API_KEY"], "Content-Type": "application/json"}
    data = None if payload is None else json.dumps(payload).encode()
    url = os.environ["SIGNOZ_URL"].rstrip("/") + path
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as response:
        body = response.read()
        return json.loads(body) if body else {}


def matches(expected: object, actual: object) -> bool:
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            matches(value, actual.get(key)) for key, value in expected.items()
        )
    if isinstance(expected, list):
        return isinstance(actual, list) and len(expected) == len(actual) and all(
            matches(left, right) for left, right in zip(expected, actual, strict=True)
        )
    return expected == actual


def install_rule(rule: dict) -> None:
    rules = request("GET", "/api/v2/rules")["data"]
    existing = [item for item in rules if item["alert"] == rule["alert"]]
    if len(existing) > 1:
        raise ValueError("duplicate OCR alert names; refusing to choose a rule")
    if existing:
        if not matches(rule, existing[0]):
            request("PUT", f"/api/v2/rules/{existing[0]['id']}", rule)
    else:
        request("POST", "/api/v2/rules", rule)
    rules = request("GET", "/api/v2/rules")["data"]
    verified = [item for item in rules if item["alert"] == rule["alert"]]
    if len(verified) != 1 or not matches(rule, verified[0]):
        raise ValueError("stored OCR alert does not match the requested configuration")
    print(f"Verified OCR alert {verified[0]['id']} (state: {verified[0]['state']})")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.apply:
        install_rule(alert_rule())
    else:
        print(json.dumps(alert_rule(), indent=2))


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as error:
        sys.exit(f"SigNoz returned HTTP {error.code}: {error.read(1000).decode()}")
