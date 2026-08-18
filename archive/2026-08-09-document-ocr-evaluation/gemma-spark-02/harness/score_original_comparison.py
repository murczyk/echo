#!/usr/bin/env python3

import argparse
import json
import pathlib
import re
import unicodedata

import markdown
from bs4 import BeautifulSoup


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive-dir", type=pathlib.Path, required=True)
    parser.add_argument("--numarkdown-bf16-dir", type=pathlib.Path, required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    return parser.parse_args()


def audited_section(path):
    match = re.search(
        r"^## Дослівн[^\n]*\n(.*?)(?=^## )",
        path.read_text(),
        flags=re.MULTILINE | re.DOTALL,
    )
    if not match:
        raise RuntimeError(f"cannot find audited transcription in {path}")
    return match.group(1).strip()


def omit_j5_image_row(text):
    return "\n".join(
        line
        for line in text.splitlines()
        if not (
            line.startswith("| Цель |")
            and any(marker in line.casefold() for marker in ("зображення", "изображение"))
        )
    )


def plain_text(text):
    html = markdown.markdown(omit_j5_image_row(text), extensions=["tables"])
    soup = BeautifulSoup(html, "lxml")
    for image in soup.find_all("img"):
        image.decompose()
    return soup.get_text(" ")


def normalize(text):
    text = unicodedata.normalize("NFKC", plain_text(text)).casefold().replace("ё", "е")
    text = re.sub(r"[^\w%]+", " ", text, flags=re.UNICODE)
    return " ".join(text.split())


def levenshtein(left, right):
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for left_index, left_value in enumerate(left, 1):
        current = [left_index]
        for right_index, right_value in enumerate(right, 1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_value != right_value),
                )
            )
        previous = current
    return previous[-1]


def error_counts(reference, candidate):
    reference = normalize(reference)
    candidate = normalize(candidate)
    reference_words = reference.split()
    candidate_words = candidate.split()
    return {
        "reference_characters": len(reference),
        "candidate_characters": len(candidate),
        "character_distance": levenshtein(reference, candidate),
        "reference_words": len(reference_words),
        "candidate_words": len(candidate_words),
        "word_distance": levenshtein(reference_words, candidate_words),
    }


def with_rates(counts):
    counts = dict(counts)
    counts["cer_percent"] = round(
        counts["character_distance"] / counts["reference_characters"] * 100, 2
    )
    counts["wer_percent"] = round(
        counts["word_distance"] / counts["reference_words"] * 100, 2
    )
    return counts


def overall(per_document):
    count_keys = (
        "reference_characters",
        "candidate_characters",
        "character_distance",
        "reference_words",
        "candidate_words",
        "word_distance",
    )
    return with_rates(
        {key: sum(metrics[key] for metrics in per_document.values()) for key in count_keys}
    )


def document_id(filename):
    return "l54" if filename.startswith("l54") else "j5"


def old_candidates(archive_dir):
    candidates = {}
    legacy_dir = archive_dir / "raw/legacy"
    nuextract = json.loads((legacy_dir / "nuextract3.vllm.raw.json").read_text())
    for run in nuextract["runs"]:
        name = f"nuextract3-bf16-{run['mode'].replace('_', '-')}"
        candidates.setdefault(name, {})[document_id(run["file"])] = run["answer"]

    numarkdown = json.loads((legacy_dir / "numarkdown.vllm.raw.json").read_text())
    for document in numarkdown["documents"]:
        candidates.setdefault("numarkdown-8b-bnb4", {})[
            document_id(document["file"])
        ] = document["answer"]

    gemma_dir = archive_dir / "gemma-spark-02/raw/1120-fp8-baseline"
    for path in gemma_dir.glob("*.json"):
        artifact = json.loads(path.read_text())
        filename = artifact["source"]["filename"]
        candidates.setdefault("gemma-4-26b-fp8-vision1120", {})[
            document_id(filename)
        ] = artifact["response"]["choices"][0]["message"]["content"]
    return candidates


def add_numarkdown_bf16(candidates, raw_dir):
    for path in raw_dir.glob("*.json"):
        artifact = json.loads(path.read_text())
        candidates.setdefault("numarkdown-8b-bf16", {})[
            artifact["document"]["id"]
        ] = artifact["answer"]


def main():
    args = parse_args()
    references = {
        "l54": audited_section(args.archive_dir / "raw/legacy/l54dw_8gZt5foedpH-PY.md"),
        "j5": omit_j5_image_row(
            audited_section(args.archive_dir / "raw/legacy/J5rHE_ZMsk1H_QDCCn3v.md")
        ),
    }
    candidates = old_candidates(args.archive_dir)
    add_numarkdown_bf16(candidates, args.numarkdown_bf16_dir)
    report = {"normalization": {
        "unicode": "NFKC",
        "casefold": True,
        "yo_to_ye": True,
        "layout_markup_removed": True,
        "j5_non_text_image_row_excluded": True,
        "aggregation": "micro-average",
    }, "models": {}}
    for name, documents in candidates.items():
        if set(documents) != set(references):
            raise RuntimeError(f"{name} is missing a document: {sorted(documents)}")
        per_document = {
            document: with_rates(error_counts(references[document], candidate))
            for document, candidate in documents.items()
        }
        report["models"][name] = {
            "documents": per_document,
            "overall": overall(per_document),
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    for name, result in report["models"].items():
        print(json.dumps({
            "model": name,
            "l54": {key: result["documents"]["l54"][key] for key in ("cer_percent", "wer_percent")},
            "j5": {key: result["documents"]["j5"][key] for key in ("cer_percent", "wer_percent")},
            "overall": {key: result["overall"][key] for key in ("cer_percent", "wer_percent")},
        }))


if __name__ == "__main__":
    main()
