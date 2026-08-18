#!/usr/bin/env python3
import base64
import json
import time
from datetime import UTC, datetime
from pathlib import Path

from openai import OpenAI

MODEL_ID = "numind/NuMarkdown-8B-Thinking"
MODEL_REVISION = "8dfc5236ae68b799d86308aae2f9717fdb50286e"
MIN_PIXELS = 100 * 28 * 28
MAX_PIXELS = 5000 * 28 * 28
INPUT_DIR = Path("/workspace/numarkdown-eval/input")
OUTPUT_PATH = Path("/workspace/numarkdown-eval/output/numarkdown.vllm.raw.json")
IMAGES = [
    INPUT_DIR / "l54dw_8gZt5foedpH-PY.jpg",
    INPUT_DIR / "J5rHE_ZMsk1H_QDCCn3v.jpg",
]


def split_response(text: str) -> tuple[str, str]:
    reasoning = ""
    answer = text.strip()
    if "<think>" in text and "</think>" in text:
        reasoning = text.split("<think>", 1)[1].split("</think>", 1)[0].strip()
    if "<answer>" in text and "</answer>" in text:
        answer = text.split("<answer>", 1)[1].split("</answer>", 1)[0].strip()
    elif "</think>" in text:
        answer = text.split("</think>", 1)[1].strip()
    return reasoning, answer


def encode_image(image_path: Path) -> str:
    payload = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return f"data:image/jpeg;base64,{payload}"


def extract_document(client: OpenAI, image_path: Path) -> dict:
    started = time.monotonic()
    try:
        response = client.chat.completions.create(
            model=MODEL_ID,
            temperature=0.7,
            seed=0,
            max_tokens=5000,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": encode_image(image_path)},
                            "min_pixels": MIN_PIXELS,
                            "max_pixels": MAX_PIXELS,
                        }
                    ],
                }
            ],
        )
        raw_text = response.choices[0].message.content or ""
        reasoning, answer = split_response(raw_text)
        return {
            "file": image_path.name,
            "status": "completed",
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "finish_reason": response.choices[0].finish_reason,
            "completion_tokens": response.usage.completion_tokens,
            "prompt_tokens": response.usage.prompt_tokens,
            "raw_text": raw_text,
            "reasoning": reasoning,
            "answer": answer,
        }
    except Exception as error:
        return {
            "file": image_path.name,
            "status": "error",
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "error_type": type(error).__name__,
            "error": str(error),
        }


def write_result(result: dict) -> None:
    OUTPUT_PATH.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def run() -> None:
    result = {
        "engine": "vLLM 0.26.0",
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "quantization": "bitsandbytes on-the-fly",
        "dtype": "bfloat16",
        "temperature": 0.7,
        "seed": 0,
        "max_tokens": 5000,
        "request_timeout_seconds": 900,
        "started_at": datetime.now(UTC).isoformat(),
        "documents": [],
    }
    client = OpenAI(
        api_key="EMPTY",
        base_url="http://127.0.0.1:8000/v1",
        timeout=900,
        max_retries=0,
    )
    for image_path in IMAGES:
        result["documents"].append(extract_document(client, image_path))
        write_result(result)


if __name__ == "__main__":
    run()
