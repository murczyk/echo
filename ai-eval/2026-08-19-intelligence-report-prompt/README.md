# Intelligence-report prompt evaluation — 2026-08-19

This evaluation selects the shared quick-suggestion prompt used by both
CBR/Cyber and Pivnich/RER. The two workflows share one prompt and one runtime
engine but are always reported separately.

The selected one-request approach produced 1.2–1.7 second live iterations.
Multi-stage and detailed GOI prompting took 4–10 seconds and could transfer
facts from examples, so it was rejected. The runtime prompt is `prompt.txt` and
is compiled into the backend with `include_str!`.

## Private data

All production-derived data, prepared cases, model responses, and human
reviews live under the gitignored `raw/` directory. They synchronize without
deletion through the standard commands:

```bash
just ai-eval-sync-from-cloud 2026-08-19-intelligence-report-prompt
just ai-eval-sync-to-cloud 2026-08-19-intelligence-report-prompt
```

The private prefix is:

```text
s3://echouastorage/lfs/echo-ai/evals/2026-08-19-intelligence-report-prompt/
```

`extract.sh` uses task-specific read-only PostgreSQL `COPY` queries streamed
over SSH directly into local `.jsonl.zst` files. It creates no production-side
files and exports no attachments, media, or unrelated tables. Each source is
preflighted and the export aborts above 750,000 rows or 2 GiB of selected text
unless the operator explicitly passes `--allow-large`.

The exports are:

- `cbr-human-pairs.jsonl.zst`: human CBR/Cyber message-report pairs;
- `pivnich-human-pairs.jsonl.zst`: human Pivnich/RER pairs, with system,
  blacklist, empty, and duplicate rows excluded;
- `pivnich-linked-goi.jsonl.zst`: message-linked GOI notes for evaluation only.

The runtime does not use GOI data. Runtime examples come from explicit
`intel_product` report links and human `sigint_comment` rows.

## Recorded export

The read-only export snapshot is `2026-08-19T07:10:00Z`. Its preflight and
prepared results are:

| Dataset | Projected rows | Selected bytes | Deduplicated rows | Development / validation |
| --- | ---: | ---: | ---: | ---: |
| CBR/Cyber | 953 | 575,295 | 953 | 150 / 75 |
| Pivnich/RER | 263,990 | 144,417,304 | 263,532 | 300 / 150 |
| Linked GOI, evaluation-only | 205 | 217,313 | 191 | 80 / 40 |

Compressed input SHA-256 values are
`5a493115ee6eadecdea6f4513af5c9897c394cae3bc06de14b351dd832a48cce`,
`da2c7db0b14706beb87284266b8bade04b415fe9774818afed48a99d2afa9c35`,
and `3b5e1947339c304b94505a3b4f24d83fe689b79a793578a17232aa3e13eb56b3`
in table order. The selected/runtime prompt SHA-256 is
`f262e654d34056b81223f522ec7751a72b7769d3f024eee070ee9654c399e1f6`.
The private manifest records the six prepared-file checksums and is synced
with the raw inputs to the B2 prefix above.

## Preparation and evaluation

```bash
python3 ai-eval/2026-08-19-intelligence-report-prompt/tools/prepare.py
python3 ai-eval/2026-08-19-intelligence-report-prompt/tools/evaluate.py \
  --run selected-validation \
  --base-url <openai-compatible-base-url>
```

Preparation produces chronological per-author targets and only attaches style
examples that precede each target. Requested sizes are 150 development / 75
validation for CBR, 300 / 150 for Pivnich, and 80 / 40 for linked GOI. The
preparation command fails rather than silently creating a smaller split.

Evaluation makes one request per case with temperature zero, a JSON schema,
512 output tokens, and a twenty-second timeout. Aggregate output reports, per
dataset, JSON validity, numeric/coordinate violations, exact match,
token/character similarity, length, median/p95 latency, and token use. Raw
responses remain gitignored while aggregate metrics are written to tracked
`runs/<run>-metrics.json`. Blinded human review rates factuality, usefulness,
and style; `--finalize` writes its aggregate to tracked
`runs/<run>-review.json`.

The prompt candidates and qualitative iteration record are under `prompts/`
and `runs/`. Dataset shape and split sizes are tracked in `datasets.json`;
prepared manifests record SHA-256 checksums for every private input and output.
