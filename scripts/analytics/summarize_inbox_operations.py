#!/usr/bin/env python3
"""Count completed inbox operations separately from candidate queries and warnings."""
import argparse
from collections import Counter
import json
from pathlib import Path
import re


def fields(message):
    return {match[0]: match[1] or match[2] for match in
            re.findall(r'\b(\w+)=(?:"([^"]*)"|(\S+))', message)}


def summarize(lines):
    final = Counter()
    candidate_fallbacks = Counter()
    warnings = Counter()
    durations = []
    for line in lines:
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            row = line
        message = row.get("MESSAGE", row.get("body", "")) if isinstance(row, dict) else row
        if not isinstance(message, str):
            continue
        values = fields(message)
        if "inbox operation completed" in message:
            key = (values.get("route", "unknown"), values.get("reason", "unknown"),
                   values.get("outcome", "unknown"), values.get("failed_stage", "unknown"))
            final[key] += 1
            if values.get("elapsed_ms", "").isdigit():
                durations.append(int(values["elapsed_ms"]))
        elif ("analytics_route" in message and values.get("operation") == "inbox message candidates"
              and values.get("route") == "postgres"):
            candidate_fallbacks[values.get("reason", "unknown")] += 1
        for marker in ("analytics_candidates_available=false", "postgres_tail_failed=true",
                       "candidate_revalidation_complete=false", "analytics_inbox_candidate_revalidation_failed",
                       "hybrid candidate revalidation incomplete", "hybrid candidate ordering incomplete",
                       "reason=revalidation_error"):
            if marker in message:
                warnings[marker] += 1
    return {
        "complete_operations": sum(final.values()),
        "final_hybrid_successes": sum(count for (route, _, outcome, _), count in final.items()
                                      if route == "analytics_hybrid" and outcome == "success"),
        "complete_fallbacks": sum(count for (route, _, _, _), count in final.items()
                                  if route == "postgres_fallback"),
        "final_outcomes": [dict(route=route, reason=reason, outcome=outcome, failed_stage=stage, count=count)
                           for (route, reason, outcome, stage), count in sorted(final.items())],
        "candidate_postgres_reasons": dict(sorted(candidate_fallbacks.items())),
        "warning_counts": dict(sorted(warnings.items())),
        "duration_ms": {"count": len(durations), "total": sum(durations), "max": max(durations, default=None)},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("logs", nargs="+", type=Path)
    args = parser.parse_args()
    result = summarize(line for path in args.logs for line in path.read_text().splitlines())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
