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
OUTPUT_PATH = Path(
    "/workspace/numarkdown-eval/output/nuextract3.structured.raw.json"
)
MODES = [
    {"name": "non_thinking", "enable_thinking": False, "temperature": 0.2},
    {"name": "thinking", "enable_thinking": True, "temperature": 0.6},
]

REPORT_TEMPLATE = {
    "addressee": "verbatim-string",
    "title": "verbatim-string",
    "opening_report": "verbatim-string",
    "observations": [
        {
            "time": "verbatim-string",
            "place": "verbatim-string",
            "coordinates": ["verbatim-string"],
            "event": "verbatim-string",
            "equipment": "verbatim-string",
            "quantity": "verbatim-string",
        }
    ],
    "main_efforts": "verbatim-string",
    "involved_assets": [
        {"asset": "verbatim-string", "count": "integer"}
    ],
    "sorties": [
        {
            "accounting_basis": ["ВЫГРУЖЕНО", "ПО ФАКТУ"],
            "type": "verbatim-string",
            "total": "integer",
            "successful": "integer",
            "success_percent": "number",
        }
    ],
    "destroyed_or_suppressed": [
        {
            "accounting_basis": ["ВЫГРУЖЕНО", "ПО ФАКТУ"],
            "target": "verbatim-string",
            "quantity": "integer",
            "place": "verbatim-string",
            "coordinates": ["verbatim-string"],
        }
    ],
    "performance_reason": "verbatim-string",
    "daily_task": "verbatim-string",
    "special_attention_areas": [
        {
            "number": "integer",
            "object_or_route": "verbatim-string",
            "coordinates": ["verbatim-string"],
        }
    ],
    "signatory_title": "verbatim-string",
    "rank": "verbatim-string",
    "name": "verbatim-string",
}

TABLE_TEMPLATE = {
    "columns": [
        {
            "title": "verbatim-string",
            "object": "verbatim-string",
            "coordinates": ["verbatim-string"],
            "planned_means": [
                {
                    "name": "verbatim-string",
                    "configuration": "verbatim-string",
                }
            ],
            "notes": "verbatim-string",
        }
    ]
}

DOCUMENTS = [
    {
        "file": INPUT_DIR / "l54dw_8gZt5foedpH-PY.jpg",
        "schema": "report",
        "template": REPORT_TEMPLATE,
        "instructions": (
            "Extract only values visibly present in the document. Preserve Russian "
            "spelling, capitalization, coordinates, equipment names and place names "
            "verbatim. Keep the two accounting bases separate. Return null or an "
            "empty list when a field is absent; do not infer values."
        ),
    },
    {
        "file": INPUT_DIR / "J5rHE_ZMsk1H_QDCCn3v.jpg",
        "schema": "target_table",
        "template": TABLE_TEMPLATE,
        "instructions": (
            "Extract exactly four data columns and omit the map images. Preserve "
            "Russian text, coordinate X/Y pairing, square numbers, equipment names "
            "and configurations verbatim. Return null or an empty list when absent; "
            "do not infer values."
        ),
    },
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


def parse_json_answer(answer: str) -> tuple[object | None, str | None]:
    candidate = answer.strip()
    if candidate.startswith("```"):
        candidate = candidate.split("\n", 1)[1]
        candidate = candidate.rsplit("```", 1)[0].strip()
    try:
        return json.loads(candidate), None
    except json.JSONDecodeError as error:
        return None, str(error)


def extract_document(client: OpenAI, document: dict, inference_mode: dict) -> dict:
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
                            "image_url": {"url": encode_image(document["file"])},
                        }
                    ],
                }
            ],
            extra_body={
                "chat_template_kwargs": {
                    "template": json.dumps(
                        document["template"], ensure_ascii=False, indent=2
                    ),
                    "instructions": document["instructions"],
                    "enable_thinking": inference_mode["enable_thinking"],
                }
            },
        )
        raw_text = response.choices[0].message.content or ""
        reasoning, answer = split_response(raw_text)
        parsed, parse_error = parse_json_answer(answer)
        return {
            "file": document["file"].name,
            "schema": document["schema"],
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
            "json_valid": parse_error is None,
            "parsed": parsed,
            "json_error": parse_error,
        }
    except Exception as error:
        return {
            "file": document["file"].name,
            "schema": document["schema"],
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
        for document in DOCUMENTS:
            result["runs"].append(
                extract_document(client, document, inference_mode)
            )
            write_result(result)


if __name__ == "__main__":
    run()
