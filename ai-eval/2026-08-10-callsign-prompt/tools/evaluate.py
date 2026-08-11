#!/usr/bin/env python3
import argparse
import concurrent.futures
import csv
import hashlib
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict

csv.field_size_limit(sys.maxsize)

EVAL_DIR = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_DATASET = EVAL_DIR / "raw" / "prepared" / "evaluation.csv"
RUNS_DIR = EVAL_DIR / "raw" / "runs"


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", required=True, type=pathlib.Path)
    parser.add_argument("--run", required=True)
    parser.add_argument("--base-url", default=os.environ.get("AI_EVAL_BASE_URL"))
    parser.add_argument("--model", default="google/gemma-4-26B-A4B-it")
    parser.add_argument("--dataset", type=pathlib.Path, default=DEFAULT_DATASET)
    parser.add_argument("--split", choices=["all", "development", "validation"], default="all")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.run):
        parser.error("--run must contain lowercase letters, digits, and hyphens")
    if not args.base_url:
        parser.error("--base-url or AI_EVAL_BASE_URL is required")
    if args.concurrency < 1 or args.concurrency > 16:
        parser.error("--concurrency must be between 1 and 16")
    return args


def load_cases(path: pathlib.Path, split: str, limit: int | None) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as input_file:
        rows = list(csv.DictReader(input_file))
    if split != "all":
        rows = [row for row in rows if row["split"] == split]
    return rows[:limit] if limit is not None else rows


def completion_url(base_url: str) -> str:
    base_url = base_url.rstrip("/")
    return base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions"


def strip_code_fence(value: str) -> str:
    value = value.strip()
    if not value.startswith("```"):
        return value
    value = value.split("\n", 1)[1] if "\n" in value else value
    return value.removesuffix("```").strip()


def normalize(values: list[str]) -> list[str]:
    result = []
    seen = set()
    for value in values:
        value = value.strip().lower()
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def parse_prediction(content: str) -> list[str]:
    value = json.loads(strip_code_fence(content))
    values = value if isinstance(value, list) else value.get("callsigns")
    if not isinstance(values, list) or not all(isinstance(item, str) for item in values):
        raise ValueError("response must contain a JSON string array named callsigns")
    return normalize(values)


def request_prediction(case: dict, prompt: str, args: argparse.Namespace) -> dict:
    payload = json.dumps(
        {
            "model": args.model,
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": case["source message"]},
            ],
            "temperature": 0,
            "max_tokens": 512,
        },
        ensure_ascii=False,
    ).encode()
    headers = {"Content-Type": "application/json"}
    if token := os.environ.get("AI_EVAL_API_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    started = time.monotonic()
    last_error = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(
                completion_url(args.base_url), data=payload, headers=headers
            )
            with urllib.request.urlopen(request, timeout=300) as response:
                body = json.load(response)
            content = body["choices"][0]["message"]["content"]
            return {
                "caseId": case["case id"],
                "prediction": parse_prediction(content),
                "rawResponse": content,
                "error": None,
                "latencyMs": round((time.monotonic() - started) * 1000),
            }
        except (KeyError, TypeError, ValueError, json.JSONDecodeError, urllib.error.URLError) as error:
            last_error = str(error)
            if attempt < 2:
                time.sleep(2**attempt)
    return {
        "caseId": case["case id"],
        "prediction": [],
        "rawResponse": "",
        "error": last_error,
        "latencyMs": round((time.monotonic() - started) * 1000),
    }


def load_predictions(path: pathlib.Path, prompt_sha256: str) -> dict[str, dict]:
    if not path.exists():
        return {}
    predictions = {}
    with path.open(encoding="utf-8") as input_file:
        for line in input_file:
            value = json.loads(line)
            if value["promptSha256"] != prompt_sha256:
                raise SystemExit(f"{path}: prompt checksum changed; use a new --run name")
            predictions[value["caseId"]] = value
    return predictions


def metric_values(cases: list[dict], predictions: dict[str, dict]) -> dict:
    exact = false_positives = false_negatives = invalid = predicted_items = expected_items = 0
    for case in cases:
        result = predictions[case["case id"]]
        expected = normalize(json.loads(case["expected callsigns"]))
        predicted = result["prediction"]
        invalid += result["error"] is not None
        exact += result["error"] is None and predicted == expected
        false_positives += len(set(predicted) - set(expected))
        false_negatives += len(set(expected) - set(predicted))
        predicted_items += len(predicted)
        expected_items += len(expected)
    true_positives = predicted_items - false_positives
    precision = true_positives / predicted_items if predicted_items else 1.0
    recall = true_positives / expected_items if expected_items else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "cases": len(cases),
        "exactCases": exact,
        "errorCases": len(cases) - exact,
        "falsePositives": false_positives,
        "falseNegatives": false_negatives,
        "invalidResponses": invalid,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(f1, 6),
    }


def grouped_metrics(cases: list[dict], predictions: dict[str, dict], field: str) -> dict:
    groups = defaultdict(list)
    for case in cases:
        groups[case[field]].append(case)
    return {name: metric_values(rows, predictions) for name, rows in sorted(groups.items())}


def ensure_run_metadata(run_dir: pathlib.Path, metadata: dict) -> None:
    path = run_dir / "metadata.json"
    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if existing != metadata:
            raise SystemExit(f"{path}: run configuration changed; use a new --run name")
    else:
        path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")


def run(args: argparse.Namespace) -> None:
    prompt = args.prompt.read_text(encoding="utf-8")
    prompt_sha256 = hashlib.sha256(prompt.encode()).hexdigest()
    dataset_sha256 = hashlib.sha256(args.dataset.read_bytes()).hexdigest()
    cases = load_cases(args.dataset, args.split, args.limit)
    run_dir = RUNS_DIR / args.run
    run_dir.mkdir(parents=True, exist_ok=True)
    ensure_run_metadata(
        run_dir,
        {
            "promptSha256": prompt_sha256,
            "datasetSha256": dataset_sha256,
            "model": args.model,
            "temperature": 0,
        },
    )
    predictions_path = run_dir / "predictions.jsonl"
    predictions = load_predictions(predictions_path, prompt_sha256)
    pending = [case for case in cases if case["case id"] not in predictions]
    print(f"run={args.run} cases={len(cases)} pending={len(pending)}", flush=True)
    with predictions_path.open("a", encoding="utf-8") as output_file:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            futures = {
                executor.submit(request_prediction, case, prompt, args): case for case in pending
            }
            for completed, future in enumerate(concurrent.futures.as_completed(futures), start=1):
                value = future.result()
                value["promptSha256"] = prompt_sha256
                predictions[value["caseId"]] = value
                output_file.write(json.dumps(value, ensure_ascii=False) + "\n")
                output_file.flush()
                if completed % 10 == 0 or completed == len(pending):
                    print(f"completed={completed}/{len(pending)}", flush=True)
    metrics = {
        "run": args.run,
        "prompt": str(args.prompt.resolve().relative_to(EVAL_DIR)),
        "promptSha256": prompt_sha256,
        "datasetSha256": dataset_sha256,
        "model": args.model,
        "split": args.split,
        "overall": metric_values(cases, predictions),
        "bySplit": grouped_metrics(cases, predictions, "split"),
        "byCaseKind": grouped_metrics(cases, predictions, "case kind"),
        "byDataset": grouped_metrics(cases, predictions, "dataset"),
    }
    (run_dir / "metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    run(arguments())
