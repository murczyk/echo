# Callsign prompt evaluation — 2026-08-10

This evaluation captures newly seen active primary callsigns from the first
roughly two days of the AI callsign worker rollout. Callsigns are treated as
AI-extracted for this corpus without attempting to distinguish later manual
edits from worker output.

The gitignored corpus is `raw/callsigns.csv`. Its columns are exactly `source
message`, `all parsed callsigns`, and `expected callsigns`; the last two start
byte-for-byte identical and contain ordered JSON arrays. Run `validate.py` to
check that invariant.

## Extraction metadata

- Snapshot: 2026-08-10 08:27:08 UTC.
- Per-server starts: `echo-siversk` 2026-08-08 13:40:07.590253 UTC;
  `echo-zp2` 2026-08-08 15:46:12.896877 UTC; `echo-pivnich` 2026-08-08
  17:35:58.393658 UTC; `echo-skhid` 2026-08-08 17:54:24.574648 UTC.
- Selection: every current-period message with at least one active primary
  callsign; manual and worker provenance are intentionally not distinguished.
- Extracted production baseline: 4,102 characters; MD5
  `e28582ad0a1e6e07be76c95dd2f33cbf`.
- Corpus: 174,618 rows, 146,016,510 bytes; SHA-256
  `f210df0071e3e1fea2e52306f8804acc5d880d8d9a8f81cea6790cc0a0dcb646`.
- Per-server rows / distinct callsigns: `echo-siversk` 14,353 / 5,167;
  `echo-zp2` 27,402 / 13,395; `echo-pivnich` 69,427 / 32,315;
  `echo-skhid` 63,436 / 24,824.
- B2: `s3://echouastorage/lfs/echo-ai/evals/2026-08-10-callsign-prompt/`.
  The uploaded `callsigns.csv` listing reported 146,016,510 bytes, and a
  streamed download reproduced the local SHA-256 above.

Extraction uses sequential SSH sessions and repeatable-read, read-only
PostgreSQL transactions with a 60-second statement timeout, a two-second lock
timeout, and no production-side files. See the reciprocal operational note in
[`archive/2026-08-10-ai-callsign-prompt/README.md`](../../archive/2026-08-10-ai-callsign-prompt/README.md).

Smaller curated extracts are documented separately. See
[`batch-01/README.md`](batch-01/README.md) for the first `echo-skhid` batch,
which selects at most one message for each supplied callsign.

## Reviewed datasets and prompt iteration

Human-reviewed inputs are immutable files under the gitignored `raw/reviews/`
directory. `datasets.json` defines their delimiter and precedence. The newer
`batch-01` review wins when the same transcript appears in both inputs;
otherwise conflicting duplicate transcripts are excluded rather than guessed.

Run the repeatable workflow with:

```bash
python3 ai-eval/2026-08-10-callsign-prompt/tools/prepare.py
python3 ai-eval/2026-08-10-callsign-prompt/tools/evaluate.py \
  --prompt ai-eval/2026-08-10-callsign-prompt/prompt.txt \
  --run <run-name> --base-url <openai-compatible-base-url>
```

Preparation currently yields 72,562 unambiguous labeled messages. The focused
307-case evaluation includes every one of the 228 human corrections plus 79
provisional unchanged guard cases. Model predictions and prepared corpora remain
under `raw/`; prompts, tools, dataset configuration, and non-sensitive run
summaries are tracked. See [`prompts/README.md`](prompts/README.md) and
[`runs/2026-08-10-iteration.md`](runs/2026-08-10-iteration.md).

The selected `prompt.txt` is 5,335 characters with SHA-256
`25a1321e9a39ce8590967c3d63f4039606a34f9527b92083cd9ab901df097c52`.
It is the same file compiled into Rust through `include_str!`.

The review inputs, prepared datasets, and resumable raw runs are uploaded under
the evaluation's `reviews/`, `prepared/`, and `runs/` B2 prefixes. Remote
checksums were verified against the local files after upload.
