#!/usr/bin/env python3
import base64
import json
import time
from datetime import UTC, datetime
from pathlib import Path

from openai import OpenAI

MODEL_ID = "numind/NuExtract3"
MODEL_REVISION = "2e9fca82ee641e6bb6e1f5d905241e994be27a07"
INPUT_DIR = Path("/workspace/numarkdown-eval/input")
OUTPUT_PATH = Path("/workspace/numarkdown-eval/output/nuextract3.vllm.raw.json")
IMAGES = [
    INPUT_DIR / "l54dw_8gZt5foedpH-PY.jpg",
    INPUT_DIR / "J5rHE_ZMsk1H_QDCCn3v.jpg",
]
MODES = [
    {"name": "non_thinking", "enable_thinking": False, "temperature": 0.2},
    {"name": "thinking", "enable_thinking": True, "temperature": 0.6},
]


def encode_image(image_path: Path) -> str:
    payload = base64.b64encode(image_path.read_bytes()).decode("ascii")
    return f"data:image/jpeg;base64,{payload}"


def split_response(text: str) -> tuple[str, str]:
    reasoning = ""
    answer = text.strip()
    if "</think>" in text:
        reasoning, answer = text.split("</think>", 1)
        reasoning = reasoning.removeprefix("<think>").strip()
        answer = answer.strip()
    return reasoning, answer


def extract_document(
    client: OpenAI,
    image_path: Path,
    inference_mode: dict,
) -> dict:
    started = time.monotonic()
    try:
        response = client.chat.completions.create(
            model=MODEL_ID,
            temperature=inference_mode["temperature"],
            seed=0,
            max_tokens=10000,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": encode_image(image_path)},
                        }
                    ],
                }
            ],
            extra_body={
                "chat_template_kwargs": {
                    "mode": "markdown",
                    "enable_thinking": inference_mode["enable_thinking"],
                }
            },
        )
        raw_text = response.choices[0].message.content or ""
        reasoning, answer = split_response(raw_text)
        return {
            "file": image_path.name,
            "mode": inference_mode["name"],
            "enable_thinking": inference_mode["enable_thinking"],
            "temperature": inference_mode["temperature"],
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
            "mode": inference_mode["name"],
            "enable_thinking": inference_mode["enable_thinking"],
            "temperature": inference_mode["temperature"],
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
        "dtype": "bfloat16",
        "quantization": None,
        "seed": 0,
        "max_tokens": 10000,
        "request_timeout_seconds": 900,
        "started_at": datetime.now(UTC).isoformat(),
        "runs": [],
    }
    client = OpenAI(
        api_key="EMPTY",
        base_url="http://127.0.0.1:8000/v1",
        timeout=900,
        max_retries=0,
    )
    for inference_mode in MODES:
        for image_path in IMAGES:
            result["runs"].append(
                extract_document(client, image_path, inference_mode)
            )
            write_result(result)


if __name__ == "__main__":
    run()
