#!/usr/bin/env python3
import argparse
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE_URL = "http://100.92.119.116:8000/v1"
MODEL_ID = "google/gemma-4-26B-A4B-it"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args()


def source_section(markdown: str) -> str:
    start_markers = ["## Дослівна транскрипція", "## Дослівна таблиця"]
    start = 0
    for marker in start_markers:
        if marker in markdown:
            start = markdown.index(marker) + len(marker)
            break
    end_marker = "## Підсумок українською"
    end = markdown.index(end_marker, start) if end_marker in markdown else len(markdown)
    return markdown[start:end].strip()


def protected_strings(source: str) -> list[str]:
    non_name_uppercase = {
        "АТ",
        "БПЛА",
        "ВР",
        "ВЫГРУЖЕНО",
        "КББМ",
        "КВО",
        "КТ",
        "ПВД",
        "ПО",
        "ПВО",
        "РОВ",
        "РЛС",
        "РЭБ",
        "РЭР",
        "СТ",
        "ФАКТУ",
        "ЧГ",
    }
    values = set(
        re.findall(
            r"(?:н\.п\.?\s*|(?<![А-Яа-яЁёІіЇїЄєҐґ])р\.\s*)([А-ЯЁІЇЄҐ][А-Яа-яЁёІіЇїЄєҐґ-]+)",
            source,
        )
    )
    values.update(
        value
        for value in re.findall(r"\b[А-ЯЁІЇЄҐ]{3,}\b", source)
        if value not in non_name_uppercase
    )
    values.update(re.findall(r"«([^»]+)»", source))
    compounds = [
        value
        for value in re.findall(
            r"[А-ЯЁІЇЄҐ][а-яёіїєґ]{2,}(?:\s*[-–]\s*[А-ЯЁІЇЄҐ][а-яёіїєґ]{2,})+",
            source,
        )
        if not re.match(r"(?i)^(?:юго|северо|південно|північно)-", value)
    ]
    values.update(compounds)
    for compound in compounds:
        values.update(re.split(r"\s*[-–]\s*", compound))
    return sorted(values)


def prompt_for(source: str, protected: list[str], feedback: list[str]) -> str:
    retry_feedback = ""
    if feedback:
        retry_feedback = (
            "\nПопередня відповідь змінила власні назви або залишила російський описовий текст: "
            + ", ".join(feedback)
            + ". Не повторюй цю помилку.\n"
        )
    protected_block = "\n".join(f"- {value}" for value in protected)
    return f"""Склади стислий фактологічний підсумок документа українською мовою.

Вимоги:
- один абзац із 3–5 речень;
- використовуй тільки факти з документа;
- звичайний описовий текст переклади природною українською мовою;
- не додавай оцінок, припущень, рекомендацій або нових чисел;
- лише рядки з protected_strings вважай захищеними власними назвами: не перекладай і не відмінюй їх;
- збережи точні координати й назви техніки, якщо згадуєш їх;
- не переписуй усі рядки й не створюй таблицю;
- поверни лише підсумок без заголовка та службового тексту.
{retry_feedback}
Рядки, які особливо важливо не змінювати:
<protected_strings>
{protected_block}
</protected_strings>

<document>
{source}
</document>"""


def request_summary(prompt: str) -> dict:
    payload = json.dumps(
        {
            "model": MODEL_ID,
            "temperature": 0,
            "seed": 0,
            "max_tokens": 800,
            "messages": [{"role": "user", "content": prompt}],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{BASE_URL}/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.load(response)


def normalized_dashes(text: str) -> str:
    return re.sub(r"\s*[-–]\s*", "-", text)


def validation(source: str, summary: str) -> dict:
    source_numbers = set(re.findall(r"\d+(?:[.,]\d+)?", source))
    summary_numbers = set(re.findall(r"\d+(?:[.,]\d+)?", summary))
    new_numbers = sorted(summary_numbers - source_numbers)
    source_place_names = set(
        re.findall(
            r"(?:н\.п\.?\s*|(?<![А-Яа-яЁёІіЇїЄєҐґ])р\.\s*)([А-ЯЁІЇЄҐ][А-Яа-яЁёІіЇїЄєҐґ-]+)",
            source,
        )
    )
    summary_place_names = set(
        re.findall(
            r"(?:н\.п\.?\s*|(?<![А-Яа-яЁёІіЇїЄєҐґ])р\.\s*)([А-ЯЁІЇЄҐ][А-Яа-яЁёІіЇїЄєҐґ-]+)",
            summary,
        )
    )
    changed_place_names = sorted(summary_place_names - source_place_names)
    summary_compounds = set(
        re.findall(
            r"[А-ЯЁІЇЄҐ][а-яёіїєґ]{2,}(?:\s*[-–]\s*[А-ЯЁІЇЄҐ][а-яёіїєґ]{2,})+",
            summary,
        )
    )
    normalized_source = normalized_dashes(source)
    changed_compounds = sorted(
        value
        for value in summary_compounds
        if normalized_dashes(value) not in normalized_source
    )
    changed_names = sorted(set(changed_place_names + changed_compounds))
    russian_residue = sorted(
        set(
            re.findall(
                r"\b(?:части|юго-восточной|выявление|поражения|происшествий|ед)\b",
                summary,
                flags=re.IGNORECASE,
            )
        )
    )
    return {
        "non_empty": bool(summary.strip()),
        "contains_ukrainian_specific_letter": bool(re.search(r"[іїєґІЇЄҐ]", summary)),
        "summary_numbers": sorted(summary_numbers),
        "numbers_not_in_source": new_numbers,
        "changed_proper_names": changed_names,
        "russian_language_residue": russian_residue,
        "passed": bool(summary.strip())
        and bool(re.search(r"[іїєґІЇЄҐ]", summary))
        and not new_numbers
        and not changed_names
        and not russian_residue,
    }


def run() -> None:
    args = parse_args()
    source = source_section(args.input.read_text(encoding="utf-8"))
    protected = protected_strings(source)
    attempts = []
    feedback = []
    for attempt_number in range(1, 3):
        prompt = prompt_for(source, protected, feedback)
        response = request_summary(prompt)
        summary = response["choices"][0]["message"]["content"].strip()
        summary_validation = validation(source, summary)
        attempts.append(
            {
                "attempt": attempt_number,
                "summary_uk": summary,
                "validation": summary_validation,
                "finish_reason": response["choices"][0]["finish_reason"],
                "usage": response.get("usage"),
            }
        )
        if summary_validation["passed"]:
            break
        feedback = (
            summary_validation["changed_proper_names"]
            + summary_validation["russian_language_residue"]
        )
    result = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "input": args.input.name,
        "model": MODEL_ID,
        "temperature": 0,
        "seed": 0,
        "attempt_count": len(attempts),
        "finish_reason": response["choices"][0]["finish_reason"],
        "usage": response.get("usage"),
        "summary_uk": summary,
        "validation": summary_validation,
        "attempts": attempts,
        "raw_response": response,
    }
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    run()
