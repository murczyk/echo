# 2026-08-10 prompt iteration

The canonical labeled set combines `full-wip` and `batch-01` with the newer
batch taking precedence. It contains 72,562 unambiguous labeled messages; 228
have explicit human corrections. The focused set contains all 228 corrections
and 79 provisional unchanged guard messages, split deterministically into 204
development and 103 validation cases. The focused dataset SHA-256 is
`938bf13d63acac7d9392a454f46840813861cab17dab5f28a40c1e8da6007aff`.

Runs used `google/gemma-4-26B-A4B-it` through the configured vLLM router with
temperature zero. Item errors are false positives plus false negatives.

| Prompt | Scope | Exact / cases | FP | FN | Item errors | F1 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Production baseline | All | 87 / 307 | 336 | 28 | 364 | 0.822957 |
| Candidate 01 | Development | 96 / 204 | 92 | 79 | 171 | 0.847458 |
| Candidate 01 | Validation | 56 / 103 | 42 | 43 | 85 | 0.866980 |
| Candidate 01 | All | 152 / 307 | 134 | 122 | 256 | 0.854545 |
| Candidate 02 | Development | 78 / 204 | 155 | 36 | 191 | 0.844336 |

Candidate 01 was selected. Against the production baseline on the full focused
set it reduced item errors by 108 (29.7%), reduced false positives by 202, and
increased exact rows by 65. The tradeoff is 94 additional false negatives, so
the next useful iteration should recover clear direct calls—especially noisy
names and genuine numeric participants—without reopening dictated-data false
positives.
