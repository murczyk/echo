#!/usr/bin/env python3
import argparse
import concurrent.futures
import difflib
import hashlib
import json
import os
import pathlib
import re
import statistics
import time
import urllib.error
import urllib.request
from collections import defaultdict

EVAL_DIR = pathlib.Path(__file__).resolve().parent.parent
PREPARED_DIR = EVAL_DIR / "raw" / "prepared"
RUNS_DIR = EVAL_DIR / "raw" / "runs"
TRACKED_RUNS_DIR = EVAL_DIR / "runs"
NUMERIC_TOKEN = re.compile(r"[\w]+(?:[.,:/°'\"-][\w]+)*", re.UNICODE)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True)
    parser.add_argument("--base-url", default=os.environ.get("AI_EVAL_BASE_URL"))
    parser.add_argument("--model", default="google/gemma-4-26B-A4B-it")
    parser.add_argument("--split", choices=["development", "validation"], default="validation")
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


def completion_url(base_url: str) -> str:
    base_url = base_url.rstrip("/")
    return base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions"


def cases(split: str, limit: int | None) -> list[dict]:
    values = []
    for path in sorted(PREPARED_DIR.glob(f"*-{split}.jsonl")):
        with path.open(encoding="utf-8") as input_file:
            values.extend(json.loads(line) for line in input_file)
    return values[:limit] if limit is not None else values


def numeric_tokens(value: str) -> set[str]:
    return {token for token in NUMERIC_TOKEN.findall(value) if any(char.isdigit() for char in token)}


def prediction(case: dict, prompt: str, args: argparse.Namespace) -> dict:
    user_input = json.dumps(
        {
            "source_materials": case["sourceMaterials"],
            "style_examples": case["styleExamples"],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    payload = json.dumps(
        {
            "model": args.model,
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": user_input},
            ],
            "temperature": 0,
            "max_tokens": 512,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "quick_intelligence_report_suggestion",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {"suggestion": {"type": "string", "minLength": 1, "maxLength": 1000}},
                        "required": ["suggestion"],
                        "additionalProperties": False,
                    },
                },
            },
        },
        ensure_ascii=False,
    ).encode()
    headers = {"Content-Type": "application/json"}
    if token := os.environ.get("AI_EVAL_API_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    started = time.monotonic()
    try:
        request = urllib.request.Request(completion_url(args.base_url), data=payload, headers=headers)
        with urllib.request.urlopen(request, timeout=20) as response:
            body = json.load(response)
        content = body["choices"][0]["message"]["content"]
        parsed = json.loads(content)
        suggestion = parsed["suggestion"].strip()
        if not suggestion or len(suggestion) > 1000 or "\n" in suggestion or "\r" in suggestion:
            raise ValueError("suggestion is not one bounded paragraph")
        usage = body.get("usage") or {}
        return {
            "caseId": case["caseId"],
            "dataset": case["dataset"],
            "suggestion": suggestion,
            "rawResponse": content,
            "jsonValid": True,
            "error": None,
            "latencyMs": round((time.monotonic() - started) * 1000),
            "promptTokens": usage.get("prompt_tokens"),
            "completionTokens": usage.get("completion_tokens"),
        }
    except (KeyError, TimeoutError, TypeError, ValueError, json.JSONDecodeError, urllib.error.URLError) as error:
        return {
            "caseId": case["caseId"],
            "dataset": case["dataset"],
            "suggestion": "",
            "rawResponse": "",
            "jsonValid": False,
            "error": str(error),
            "latencyMs": round((time.monotonic() - started) * 1000),
            "promptTokens": None,
            "completionTokens": None,
        }


def percentile(values: list[int], fraction: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, int(len(ordered) * fraction + 0.999999) - 1))]


def token_similarity(left: str, right: str) -> float:
    left_tokens = set(left.casefold().split())
    right_tokens = set(right.casefold().split())
    union = left_tokens | right_tokens
    return len(left_tokens & right_tokens) / len(union) if union else 1.0


def aggregate(group_cases: list[dict], results: dict[str, dict]) -> dict:
    values = [results[case["caseId"]] for case in group_cases]
    valid = [value for value in values if value["jsonValid"]]
    latencies = [value["latencyMs"] for value in values]
    character_scores = []
    token_scores = []
    violations = 0
    exact = 0
    lengths = []
    for case in group_cases:
        value = results[case["caseId"]]
        if not value["jsonValid"]:
            continue
        suggestion = value["suggestion"]
        expected = case["expected"].strip()
        source = "\n".join(case["sourceMaterials"])
        violations += bool(numeric_tokens(suggestion) - numeric_tokens(source))
        exact += suggestion.casefold() == expected.casefold()
        character_scores.append(difflib.SequenceMatcher(None, suggestion.casefold(), expected.casefold()).ratio())
        token_scores.append(token_similarity(suggestion, expected))
        lengths.append(len(suggestion))
    prompt_tokens = [value["promptTokens"] for value in valid if value["promptTokens"] is not None]
    completion_tokens = [value["completionTokens"] for value in valid if value["completionTokens"] is not None]
    return {
        "cases": len(group_cases),
        "jsonValid": len(valid),
        "jsonValidityRate": round(len(valid) / len(group_cases), 6) if group_cases else 0,
        "numericCoordinateViolations": violations,
        "exactMatches": exact,
        "exactMatchRate": round(exact / len(group_cases), 6) if group_cases else 0,
        "meanCharacterSimilarity": round(statistics.fmean(character_scores), 6) if character_scores else None,
        "meanTokenSimilarity": round(statistics.fmean(token_scores), 6) if token_scores else None,
        "meanLengthChars": round(statistics.fmean(lengths), 2) if lengths else None,
        "medianLatencyMs": round(statistics.median(latencies)) if latencies else None,
        "p95LatencyMs": percentile(latencies, 0.95),
        "promptTokens": sum(prompt_tokens) if prompt_tokens else None,
        "completionTokens": sum(completion_tokens) if completion_tokens else None,
    }


def main() -> None:
    args = arguments()
    prompt = (EVAL_DIR / "prompt.txt").read_text(encoding="utf-8")
    selected_cases = cases(args.split, args.limit)
    run_dir = RUNS_DIR / args.run
    run_dir.mkdir(parents=True, exist_ok=True)
    responses_path = run_dir / "responses.jsonl"
    results = {}
    with responses_path.open("w", encoding="utf-8") as output_file:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            futures = {
                executor.submit(prediction, case, prompt, args): case for case in selected_cases
            }
            for future in concurrent.futures.as_completed(futures):
                value = future.result()
                results[value["caseId"]] = value
                output_file.write(json.dumps(value, ensure_ascii=False) + "\n")
                output_file.flush()
    grouped = defaultdict(list)
    for case in selected_cases:
        grouped[case["dataset"]].append(case)
    metrics = {
        "run": args.run,
        "split": args.split,
        "model": args.model,
        "promptSha256": hashlib.sha256(prompt.encode()).hexdigest(),
        "byDataset": {name: aggregate(rows, results) for name, rows in sorted(grouped.items())},
    }
    TRACKED_RUNS_DIR.mkdir(parents=True, exist_ok=True)
    metrics_path = TRACKED_RUNS_DIR / f"{args.run}-metrics.json"
    metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
