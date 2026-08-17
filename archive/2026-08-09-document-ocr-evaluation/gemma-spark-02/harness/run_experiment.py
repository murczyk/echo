#!/usr/bin/env python3

import argparse
import base64
import copy
import datetime as dt
import hashlib
import json
import mimetypes
import pathlib
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from prompts.prompts import DOCUMENTS, STRUCTURED

MODEL_ID = "google/gemma-4-26B-A4B-it"
REPETITION_DETECTION = {
    "min_pattern_size": 3,
    "max_pattern_size": 20,
    "min_count": 4,
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", required=True, choices=[
        "baseline", "sweep", "prompt-compare", "penalty", "finalist", "structured",
        "j5-penalty",
    ])
    parser.add_argument("--input-dir", type=pathlib.Path, default=ROOT / "input")
    parser.add_argument("--output-dir", type=pathlib.Path, default=ROOT / "raw")
    parser.add_argument("--runtime-manifest", type=pathlib.Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/v1")
    parser.add_argument("--vision-budget", type=int, choices=[280, 1120], required=True)
    parser.add_argument("--precision", choices=["fp8", "bf16"], required=True)
    parser.add_argument("--temperature", type=float, default=1.0)
    parser.add_argument("--repetition-penalty", type=float, default=1.0)
    parser.add_argument("--timeout", type=int, default=1200)
    return parser.parse_args()


def sampled_values(temperature):
    if temperature == 0:
        return {"temperature": 0, "top_p": 1.0, "top_k": 0}
    return {"temperature": temperature, "top_p": 0.95, "top_k": 64}


def plain_case(document, prompt_version, temperature, seed, detection, penalty=1.0):
    config = DOCUMENTS[document]
    case = {
        "document": document,
        "prompt_version": prompt_version,
        "prompt": config[f"{prompt_version}_prompt"],
        "max_tokens": config["original_max_tokens"],
        "seed": seed,
        "repetition_detection": detection,
        "repetition_penalty": penalty,
        **sampled_values(temperature),
    }
    return case


def build_cases(args):
    if args.phase == "baseline":
        return [plain_case(document, "original", 0, 0, False) for document in DOCUMENTS]
    if args.phase == "sweep":
        cases = [plain_case("l54", "original", 0, 0, True)]
        for temperature in (0.2, 0.5, 0.7, 1.0):
            cases.extend(plain_case("l54", "original", temperature, seed, True) for seed in range(3))
        return cases
    if args.phase == "prompt-compare":
        return [
            plain_case("l54", prompt_version, args.temperature, seed, True)
            for prompt_version in ("original", "bounded")
            for seed in range(3)
        ]
    if args.phase == "penalty":
        return [
            plain_case("l54", "bounded", args.temperature, seed, True, penalty)
            for penalty in (1.03, 1.05)
            for seed in range(3)
        ]
    if args.phase == "j5-penalty":
        return [
            plain_case("j5", "original", 0, seed, True, penalty)
            for penalty in (1.03, 1.05)
            for seed in range(3)
        ]
    if args.phase == "finalist":
        return [
            plain_case(
                document,
                "original" if document == "j5" else "bounded",
                args.temperature,
                seed,
                True,
                args.repetition_penalty,
            )
            for document in DOCUMENTS
            for seed in range(5)
        ]
    cases = []
    for document, structured in STRUCTURED.items():
        cases.append({
            "document": document,
            "prompt_version": "historical_json_schema",
            "prompt": structured["prompt"],
            "max_tokens": structured["max_tokens"],
            "seed": 0,
            "repetition_detection": True,
            "repetition_penalty": 1.0,
            "temperature": 0,
            "top_p": 1.0,
            "top_k": 0,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": f"{document}_historical_schema",
                    "strict": True,
                    "schema": structured["schema"],
                },
            },
        })
    return cases


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def image_data_url(path):
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{media_type};base64,{base64.b64encode(path.read_bytes()).decode()}"


def request_for(case, image_path):
    request = {
        "model": MODEL_ID,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": image_data_url(image_path)}},
                {"type": "text", "text": case["prompt"]},
            ],
        }],
        "max_tokens": case["max_tokens"],
        "temperature": case["temperature"],
        "top_p": case["top_p"],
        "top_k": case["top_k"],
        "seed": case["seed"],
        "repetition_penalty": case["repetition_penalty"],
    }
    if case["prompt_version"].startswith("bounded") or case["prompt_version"].endswith("_v3"):
        request["stop"] = ["<END_OCR>"]
    if case["repetition_detection"]:
        request["repetition_detection"] = REPETITION_DETECTION
    if "response_format" in case:
        request["response_format"] = case["response_format"]
    return request


def redacted_request(request):
    request = copy.deepcopy(request)
    request["messages"][0]["content"][0]["image_url"]["url"] = "<image-base64-omitted>"
    return request


def post_json(url, payload, timeout):
    body = json.dumps(payload, ensure_ascii=False).encode()
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result = json.load(response)
        error = None
    except urllib.error.HTTPError as exception:
        result = None
        error = {
            "type": "http_error",
            "status": exception.code,
            "body": exception.read().decode(errors="replace"),
        }
    except Exception as exception:
        result = None
        error = {"type": type(exception).__name__, "message": str(exception)}
    return result, error, time.perf_counter() - started


def case_id(args, case):
    temperature = str(case["temperature"]).replace(".", "p")
    penalty = str(case["repetition_penalty"]).replace(".", "p")
    return (
        f"{args.phase}__{case['document']}__{case['prompt_version']}"
        f"__t{temperature}__s{case['seed']}__rp{penalty}"
        f"__v{args.vision_budget}__{args.precision}"
    )


def main():
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    runtime = None
    if args.runtime_manifest:
        runtime = json.loads(args.runtime_manifest.read_text())

    for case in build_cases(args):
        image_path = args.input_dir / DOCUMENTS[case["document"]]["filename"]
        actual_sha256 = file_sha256(image_path)
        expected_sha256 = DOCUMENTS[case["document"]]["sha256"]
        if actual_sha256 != expected_sha256:
            raise RuntimeError(f"SHA-256 mismatch for {image_path.name}")

        request = request_for(case, image_path)
        response, error, latency = post_json(
            f"{args.base_url.rstrip('/')}/chat/completions", request, args.timeout
        )
        identifier = case_id(args, case)
        artifact = {
            "id": identifier,
            "timestamp_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "source": {"filename": image_path.name, "sha256": actual_sha256},
            "prompt_version": case["prompt_version"],
            "vision_budget": args.vision_budget,
            "precision": args.precision,
            "runtime": runtime,
            "request": redacted_request(request),
            "response": response,
            "error": error,
            "latency_seconds": latency,
            "finish_reason": response["choices"][0]["finish_reason"] if response else None,
            "usage": response.get("usage") if response else None,
        }
        output_path = args.output_dir / f"{identifier}.json"
        output_path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({
            "id": identifier,
            "finish_reason": artifact["finish_reason"],
            "usage": artifact["usage"],
            "latency_seconds": round(latency, 3),
            "error": error,
        }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
