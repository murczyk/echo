#!/usr/bin/env python3

import argparse
import base64
import copy
import datetime as dt
import hashlib
import json
import pathlib
import time
import urllib.error
import urllib.request

MODEL_ID = "numind/NuMarkdown-8B-Thinking"
MODEL_REVISION = "8dfc5236ae68b799d86308aae2f9717fdb50286e"


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=pathlib.Path, required=True)
    parser.add_argument("--input-dir", type=pathlib.Path, required=True)
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/v1")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--resume", action="store_true")
    return parser.parse_args()


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def request_for(page, image_path):
    image = base64.b64encode(image_path.read_bytes()).decode()
    return {
        "model": MODEL_ID,
        "messages": [{
            "role": "user",
            "content": [{"type": "image_url", "image_url": {"url": f"data:{page['mime_type']};base64,{image}"}}],
        }],
        "max_tokens": 10000,
        "temperature": 0.7,
        "seed": 0,
    }


def redacted_request(request):
    request = copy.deepcopy(request)
    request["messages"][0]["content"][0]["image_url"]["url"] = "<image-base64-omitted>"
    return request


def post_json(url, request, timeout):
    body = json.dumps(request).encode()
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.load(response), None, time.monotonic() - started
    except urllib.error.HTTPError as exception:
        error = {"type": "http_error", "status": exception.code, "body": exception.read().decode(errors="replace")}
    except Exception as exception:
        error = {"type": type(exception).__name__, "message": str(exception)}
    return None, error, time.monotonic() - started


def output_path(args, document, page):
    return args.output_dir / f"{document['id']}__p{page['index']:02d}__numarkdown__bf16.json"


def split_response(response):
    if not response:
        return "", ""
    text = response["choices"][0]["message"].get("content", "")
    if "</think>" not in text:
        return "", text.strip()
    reasoning, answer = text.split("</think>", 1)
    answer = answer.strip().removeprefix("<answer>").removesuffix("</answer>").strip()
    return reasoning.removeprefix("<think>").strip(), answer


def run_page(args, document, page):
    image_path = args.input_dir / page["filename"]
    actual_sha256 = file_sha256(image_path)
    if actual_sha256 != page["sha256"]:
        raise RuntimeError(f"SHA-256 mismatch for {image_path}")
    request = request_for(page, image_path)
    response, error, latency = post_json(
        f"{args.base_url.rstrip('/')}/chat/completions", request, args.timeout
    )
    reasoning, answer = split_response(response)
    artifact = {
        "id": output_path(args, document, page).stem,
        "timestamp_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "suite_id": args.manifest_data["suite_id"],
        "document": {"id": document["id"], "profile": document["profile"], "page_index": page["index"]},
        "source": {key: page[key] for key in ("filename", "sha256", "mime_type", "width", "height")},
        "output_format": "markdown-with-html-tables",
        "runtime": {
            "engine": "NVIDIA vLLM 26.07 / vLLM 0.24.0",
            "model": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "dtype": "bfloat16",
            "quantization": None,
        },
        "request": redacted_request(request),
        "response": response,
        "reasoning": reasoning,
        "answer": answer,
        "error": error,
        "latency_seconds": latency,
        "finish_reason": response["choices"][0]["finish_reason"] if response else None,
        "usage": response.get("usage") if response else None,
    }
    path = output_path(args, document, page)
    path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "id": artifact["id"], "finish_reason": artifact["finish_reason"],
        "usage": artifact["usage"], "latency_seconds": round(latency, 3), "error": error,
    }, ensure_ascii=False), flush=True)


def main():
    args = parse_args()
    args.manifest_data = json.loads(args.manifest.read_text())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for document in args.manifest_data["documents"]:
        for page in document["pages"]:
            path = output_path(args, document, page)
            if args.resume and path.exists():
                print(json.dumps({"id": path.stem, "status": "skipped"}), flush=True)
                continue
            run_page(args, document, page)


if __name__ == "__main__":
    main()
