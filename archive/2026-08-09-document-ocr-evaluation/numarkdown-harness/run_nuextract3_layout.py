#!/usr/bin/env python3

import base64
import copy
import hashlib
import json
import mimetypes
import time
from datetime import UTC, datetime
from pathlib import Path

from openai import OpenAI

PROJECT_DIR = Path("/workspace/numarkdown-eval")
INPUT_DIR = PROJECT_DIR / "input"
OUTPUT_DIR = PROJECT_DIR / "output" / "layout-suite-nuextract3-bf16"
MANIFEST_PATH = PROJECT_DIR / "layout-suite-manifest.json"
MODEL_ID = "numind/NuExtract3"
MODEL_REVISION = "2e9fca82ee641e6bb6e1f5d905241e994be27a07"


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def image_data_url(path, mime_type):
    mime_type = mime_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime_type};base64,{base64.b64encode(path.read_bytes()).decode()}"


def request_for(page):
    return {
        "model": MODEL_ID,
        "temperature": 0.2,
        "seed": 0,
        "max_tokens": 10000,
        "messages": [{
            "role": "user",
            "content": [{
                "type": "image_url",
                "image_url": {"url": image_data_url(INPUT_DIR / page["filename"], page["mime_type"])},
            }],
        }],
        "extra_body": {
            "chat_template_kwargs": {"mode": "markdown", "enable_thinking": False}
        },
    }


def redacted_request(request):
    request = copy.deepcopy(request)
    request["messages"][0]["content"][0]["image_url"]["url"] = "<image-base64-omitted>"
    return request


def split_response(text):
    if "</think>" not in text:
        return "", text.strip()
    reasoning, answer = text.split("</think>", 1)
    return reasoning.removeprefix("<think>").strip(), answer.strip()


def output_path(document, page):
    return OUTPUT_DIR / f"{document['id']}__p{page['index']:02d}__nuextract3__bf16__non-thinking.json"


def run_page(client, document, page):
    image_path = INPUT_DIR / page["filename"]
    actual_sha256 = file_sha256(image_path)
    if actual_sha256 != page["sha256"]:
        raise RuntimeError(f"SHA-256 mismatch for {image_path}")
    request = request_for(page)
    started = time.monotonic()
    error = None
    try:
        response = client.chat.completions.create(**request)
        response_data = response.model_dump(mode="json")
    except Exception as exception:
        response_data = None
        error = {"type": type(exception).__name__, "message": str(exception)}
    latency = time.monotonic() - started
    content = response_data["choices"][0]["message"].get("content", "") if response_data else ""
    reasoning, answer = split_response(content)
    artifact = {
        "id": output_path(document, page).stem,
        "timestamp_utc": datetime.now(UTC).isoformat(),
        "suite_id": "14aug26-layout-html-v1",
        "document": {"id": document["id"], "profile": document["profile"], "page_index": page["index"]},
        "source": {key: page[key] for key in ("filename", "sha256", "mime_type", "width", "height")},
        "output_format": "markdown-with-html-tables",
        "runtime": {
            "engine": "vLLM 0.26.0",
            "model": MODEL_ID,
            "model_revision": MODEL_REVISION,
            "dtype": "bfloat16",
            "quantization": None,
        },
        "request": redacted_request(request),
        "response": response_data,
        "reasoning": reasoning,
        "answer": answer,
        "error": error,
        "latency_seconds": latency,
        "finish_reason": response_data["choices"][0]["finish_reason"] if response_data else None,
        "usage": response_data.get("usage") if response_data else None,
    }
    path = output_path(document, page)
    path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "id": artifact["id"],
        "finish_reason": artifact["finish_reason"],
        "usage": artifact["usage"],
        "latency_seconds": round(latency, 3),
        "error": error,
    }, ensure_ascii=False), flush=True)


def main():
    manifest = json.loads(MANIFEST_PATH.read_text())
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    client = OpenAI(api_key="EMPTY", base_url="http://127.0.0.1:8000/v1", timeout=900, max_retries=0)
    for document in manifest["documents"]:
        for page in document["pages"]:
            path = output_path(document, page)
            if path.exists():
                print(json.dumps({"id": path.stem, "status": "skipped"}), flush=True)
                continue
            run_page(client, document, page)


if __name__ == "__main__":
    main()
