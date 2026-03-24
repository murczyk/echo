# Speaker Extraction Heuristics

Goal: return the callsigns of the speakers who are actually participating in the conversation.

Rules:

- Direct address patterns like `Шыш, я Учитель, прием` usually identify two speakers: addressee and self-identified speaker.
- Repetition at line start like `Фаза, Фаза, я Мирный` is strong speaker evidence.
- Header callsigns are hints, not proof by themselves.
- Mentions inside content like `там ГНОМ его встречает` are not speakers unless that callsign also appears in dialogue as a participant.
- Normalize obvious typos or OCR drops when the intended callsign is clear from the same line or surrounding context.
- Return deduplicated uppercase callsigns.
- Prefer fewer high-confidence callsigns over a longer speculative list.

Output only strict JSON:

```json
[
  { "callsign": "УЧИТЕЛЬ", "conf": 0.95 },
  { "callsign": "ШЫШ", "conf": 0.95 }
]
```
