#!/usr/bin/env python3
import argparse
import json
import resource
import time
from pathlib import Path

import torch
from PIL import Image
from transformers import (
    AutoProcessor,
    BitsAndBytesConfig,
    Qwen2_5_VLForConditionalGeneration,
)

MODEL_ID = "numind/NuMarkdown-8B-Thinking"
MODEL_REVISION = "8dfc5236ae68b799d86308aae2f9717fdb50286e"
MIN_PIXELS = 100 * 28 * 28
MAX_PIXELS = 5000 * 28 * 28


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("images", nargs="+", type=Path)
    return parser.parse_args()


def load_ocr_engine():
    quantization = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    processor = AutoProcessor.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        trust_remote_code=True,
        min_pixels=MIN_PIXELS,
        max_pixels=MAX_PIXELS,
    )
    ocr_engine = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        torch_dtype=torch.bfloat16,
        quantization_config=quantization,
        device_map={"": 0},
        attn_implementation="sdpa",
        low_cpu_mem_usage=True,
        trust_remote_code=True,
    )
    ocr_engine.eval()
    return processor, ocr_engine


def prepare_inputs(processor, image_path: Path):
    image = Image.open(image_path).convert("RGB")
    messages = [{"role": "user", "content": [{"type": "image"}]}]
    prompt = processor.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
    )
    inputs = processor(
        text=[prompt],
        images=[image],
        padding=True,
        return_tensors="pt",
    )
    return image, inputs.to("cuda")


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


def generate_document(processor, ocr_engine, image_path: Path) -> dict:
    image, inputs = prepare_inputs(processor, image_path)
    torch.cuda.reset_peak_memory_stats()
    started = time.monotonic()
    with torch.inference_mode():
        output_ids = ocr_engine.generate(
            **inputs,
            max_new_tokens=5000,
            temperature=0.7,
            do_sample=True,
        )
    elapsed = time.monotonic() - started
    generated_ids = output_ids[:, inputs.input_ids.shape[1] :]
    raw_text = processor.batch_decode(
        generated_ids,
        skip_special_tokens=True,
        clean_up_tokenization_spaces=False,
    )[0]
    reasoning, answer = split_response(raw_text)
    return {
        "file": image_path.name,
        "width": image.width,
        "height": image.height,
        "elapsed_seconds": round(elapsed, 3),
        "generated_tokens": int(generated_ids.shape[1]),
        "peak_allocated_gib": round(
            torch.cuda.max_memory_allocated() / 1024**3,
            3,
        ),
        "raw_text": raw_text,
        "reasoning": reasoning,
        "answer": answer,
    }


def run() -> None:
    args = parse_args()
    torch.manual_seed(0)
    torch.cuda.manual_seed_all(0)
    load_started = time.monotonic()
    processor, ocr_engine = load_ocr_engine()
    load_seconds = time.monotonic() - load_started
    result = {
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "quantization": "bitsandbytes NF4 4-bit, double quantization",
        "compute_dtype": "bfloat16",
        "attention": "sdpa",
        "temperature": 0.7,
        "seed": 0,
        "max_new_tokens": 5000,
        "min_pixels": MIN_PIXELS,
        "max_pixels": MAX_PIXELS,
        "load_seconds": round(load_seconds, 3),
        "process_peak_rss_gib": round(
            resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024**2,
            3,
        ),
        "documents": [],
    }
    for image_path in args.images:
        result["documents"].append(
            generate_document(processor, ocr_engine, image_path)
        )
        args.output.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )


if __name__ == "__main__":
    run()
