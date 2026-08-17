#!/usr/bin/env python3

import argparse
import base64
import copy
import datetime as dt
import hashlib
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from prompts.layout_suite import END_MARKER, PROMPTS

MODEL_ID = "google/gemma-4-26B-A4B-it"
REPETITION_DETECTION = {
    "min_pattern_size": 3,
    "max_pattern_size": 20,
    "min_count": 4,
}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=pathlib.Path, default=ROOT / "layout-suite-manifest.json")
    parser.add_argument("--input-dir", type=pathlib.Path, default=ROOT / "input")
    parser.add_argument("--output-dir", type=pathlib.Path, default=ROOT / "raw" / "layout-suite-fp8-1120")
    parser.add_argument("--runtime-manifest", type=pathlib.Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/v1")
    parser.add_argument("--document", action="append", dest="documents")
    parser.add_argument("--vision-budget", type=int, default=1120)
    parser.add_argument("--precision", choices=["fp8", "bf16"], default="fp8")
    parser.add_argument("--max-tokens-table", type=int, default=12000)
    parser.add_argument("--max-tokens-document", type=int, default=10000)
    parser.add_argument("--timeout", type=int, default=1200)
    parser.add_argument("--repetition-detection", action="store_true")
    parser.add_argument("--resume", action="store_true")
    return parser.parse_args()


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def image_data_url(path, media_type):
    encoded = base64.b64encode(path.read_bytes()).decode()
    return f"data:{media_type};base64,{encoded}"


def selected_pages(manifest, document_ids):
    known_ids = {document["id"] for document in manifest["documents"]}
    unknown_ids = set(document_ids or []) - known_ids
    if unknown_ids:
        raise ValueError(f"unknown document ids: {', '.join(sorted(unknown_ids))}")
    for document in manifest["documents"]:
        if document_ids and document["id"] not in document_ids:
            continue
        for page in document["pages"]:
            yield document, page


def request_for(args, document, page, image_path):
    max_tokens = (
        args.max_tokens_table if document["profile"] == "table" else args.max_tokens_document
    )
    request = {
        "model": MODEL_ID,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": image_data_url(image_path, page["mime_type"])}},
                {"type": "text", "text": PROMPTS[document["profile"]]},
            ],
        }],
        "max_tokens": max_tokens,
        "temperature": 0,
        "top_p": 1.0,
        "top_k": 0,
        "seed": 0,
        "repetition_penalty": 1.0,
        "stop": [END_MARKER],
    }
    if args.repetition_detection:
        request["repetition_detection"] = REPETITION_DETECTION
    return request


def redacted_request(request):
    request = copy.deepcopy(request)
    request["messages"][0]["content"][0]["image_url"]["url"] = "<image-base64-omitted>"
    return request


def post_json(url, payload, timeout):
    body = json.dumps(payload, ensure_ascii=False).encode()
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
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


def artifact_path(args, document, page):
    suffix = "repetition" if args.repetition_detection else "plain"
    name = f"{document['id']}__p{page['index']:02d}__html__{args.precision}__v{args.vision_budget}__{suffix}.json"
    return args.output_dir / name


def write_artifact(args, document, page, runtime, request, response, error, latency, output_path):
    artifact = {
        "id": output_path.stem,
        "timestamp_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "suite_id": args.manifest_data["suite_id"],
        "document": {"id": document["id"], "profile": document["profile"], "page_index": page["index"]},
        "source": {key: page[key] for key in ("filename", "sha256", "mime_type", "width", "height")},
        "prompt_version": f"semantic-html-{document['profile']}-v1",
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
    output_path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n")
    return artifact


def main():
    args = parse_args()
    args.manifest_data = json.loads(args.manifest.read_text())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    runtime = json.loads(args.runtime_manifest.read_text()) if args.runtime_manifest else None
    endpoint = f"{args.base_url.rstrip('/')}/chat/completions"

    for document, page in selected_pages(args.manifest_data, args.documents):
        output_path = artifact_path(args, document, page)
        if args.resume and output_path.exists():
            print(json.dumps({"id": output_path.stem, "status": "skipped"}), flush=True)
            continue
        image_path = args.input_dir / page["filename"]
        if file_sha256(image_path) != page["sha256"]:
            raise RuntimeError(f"SHA-256 mismatch for {image_path}")
        request = request_for(args, document, page, image_path)
        response, error, latency = post_json(endpoint, request, args.timeout)
        artifact = write_artifact(
            args, document, page, runtime, request, response, error, latency, output_path
        )
        print(json.dumps({
            "id": artifact["id"],
            "finish_reason": artifact["finish_reason"],
            "usage": artifact["usage"],
            "latency_seconds": round(latency, 3),
            "error": error,
        }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
