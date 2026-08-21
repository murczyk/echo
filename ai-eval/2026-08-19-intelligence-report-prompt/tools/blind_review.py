#!/usr/bin/env python3
import argparse
import csv
import hashlib
import json
import pathlib
import random
import re
from collections import defaultdict

EVAL_DIR = pathlib.Path(__file__).resolve().parent.parent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run")
    parser.add_argument("--finalize", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.run):
        parser.error("run must contain lowercase letters, digits, and hyphens")
    run_dir = EVAL_DIR / "raw" / "runs" / args.run
    review_path = EVAL_DIR / "raw" / "reviews" / f"{args.run}.csv"
    review_path.parent.mkdir(parents=True, exist_ok=True)
    if not args.finalize:
        responses = {}
        with (run_dir / "responses.jsonl").open(encoding="utf-8") as input_file:
            for line in input_file:
                value = json.loads(line)
                responses[value["caseId"]] = value
        cases = []
        for path in (EVAL_DIR / "raw" / "prepared").glob("*-validation.jsonl"):
            with path.open(encoding="utf-8") as input_file:
                cases.extend(json.loads(line) for line in input_file)
        random.Random(hashlib.sha256(args.run.encode()).digest()).shuffle(cases)
        with review_path.open("w", newline="", encoding="utf-8") as output_file:
            writer = csv.DictWriter(
                output_file,
                fieldnames=[
                    "reviewId",
                    "dataset",
                    "sourceMaterials",
                    "suggestion",
                    "factuality1to5",
                    "usefulness1to5",
                    "style1to5",
                    "reviewerNote",
                ],
            )
            writer.writeheader()
            for case in cases:
                value = responses.get(case["caseId"])
                if value and value["jsonValid"]:
                    writer.writerow(
                        {
                            "reviewId": hashlib.sha256(case["caseId"].encode()).hexdigest()[:16],
                            "dataset": case["dataset"],
                            "sourceMaterials": "\n\n".join(case["sourceMaterials"]),
                            "suggestion": value["suggestion"],
                        }
                    )
        print(review_path)
        return

    scores = defaultdict(lambda: defaultdict(list))
    with review_path.open(newline="", encoding="utf-8") as input_file:
        for row in csv.DictReader(input_file):
            for field in ("factuality1to5", "usefulness1to5", "style1to5"):
                if row[field].strip():
                    score = int(row[field])
                    if score < 1 or score > 5:
                        raise SystemExit(f"{row['reviewId']}: {field} must be 1..5")
                    scores[row["dataset"]][field].append(score)
    summary = {
        dataset: {
            field: {"reviews": len(values), "mean": round(sum(values) / len(values), 3)}
            for field, values in fields.items()
            if values
        }
        for dataset, fields in scores.items()
    }
    tracked_runs = EVAL_DIR / "runs"
    tracked_runs.mkdir(parents=True, exist_ok=True)
    summary_path = tracked_runs / f"{args.run}-review.json"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
