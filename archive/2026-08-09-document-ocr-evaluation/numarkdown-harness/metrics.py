#!/usr/bin/env python3
import json
import re
from pathlib import Path

REFERENCE = """Доклад
Настоящим докладываю за день в отряде Спарта без происшествий.
С 06:50 до 07:30 на насыпную дамбу в районе н.п.Разумовка (9161) заехало на
выгрузку 4 ед. автомобильной техники типа «Тонар».
Наблюдается изменение характера ведения боевых действий противником - активное применение БпЛА типа MAVIC в районе н.п. Скельки, а также дронов-перехватчиков в районах МАЯЧКА, СКЕЛЬКИ, ЗЛАТОПОЛЬ. Отмечалось увеличение применения FPV-дронов противником на рубеже Днепрорудное-Маячки-Скельки. За день на рубеже Днепрорудное - Васильевка отмечалась высокая активность пролетов различных типов БпЛА противника. Средствами РЭБ и РЭР отряда зафиксировано до 45 БпЛА противника.
Радиосвязь работает исправно."""


def distance(left, right) -> int:
    previous = list(range(len(right) + 1))
    for row, left_item in enumerate(left, 1):
        current = [row]
        for column, right_item in enumerate(right, 1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (left_item != right_item),
                )
            )
        previous = current
    return previous[-1]


def normalize(text: str) -> str:
    text = re.sub(r"-\s*\n\s*", "-", text)
    return re.sub(r"\s+", " ", text).strip()


def reference_span(text: str) -> str:
    start = text.index("Доклад")
    end_marker = "Радиосвязь работает исправно."
    end = text.index(end_marker, start) + len(end_marker)
    span = text[start:end]
    span = re.sub(r"^Доклад\s*\n\s*Командиру[^\n]*\n", "Доклад\n", span)
    return normalize(span)


def metrics(hypothesis: str) -> dict:
    reference = normalize(REFERENCE)
    hypothesis = reference_span(hypothesis)
    character_distance = distance(reference, hypothesis)
    reference_words = reference.split()
    hypothesis_words = hypothesis.split()
    word_distance = distance(reference_words, hypothesis_words)
    return {
        "reference_characters": len(reference),
        "hypothesis_characters": len(hypothesis),
        "character_distance": character_distance,
        "cer_percent": round(character_distance / len(reference) * 100, 2),
        "reference_words": len(reference_words),
        "hypothesis_words": len(hypothesis_words),
        "word_distance": word_distance,
        "wer_percent": round(word_distance / len(reference_words) * 100, 2),
    }


results = Path("/home/ubuntu/Downloads/eval-storage/results")
numarkdown = json.loads((results / "numarkdown.vllm.raw.json").read_text())
nuextract3 = json.loads((results / "nuextract3.vllm.raw.json").read_text())
gemma = json.loads((results / "l54dw_8gZt5foedpH-PY.gemma.raw.json").read_text())
gemma_top = next(run for run in gemma["runs"] if run["name"] == "crop_top_transcription")
nuextract3_report = {
    run["mode"]: metrics(run["answer"])
    for run in nuextract3["runs"]
    if run["file"] == "l54dw_8gZt5foedpH-PY.jpg"
}
print(
    json.dumps(
        {
            "gemma_top_crop": metrics(
                gemma_top["response"]["choices"][0]["message"]["content"]
            ),
            "numarkdown_full_page": metrics(numarkdown["documents"][0]["answer"]),
            "nuextract3_non_thinking_full_page": nuextract3_report[
                "non_thinking"
            ],
            "nuextract3_thinking_full_page": nuextract3_report["thinking"],
        },
        ensure_ascii=False,
        indent=2,
    )
)
