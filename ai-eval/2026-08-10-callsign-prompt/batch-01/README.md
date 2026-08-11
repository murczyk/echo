# Callsign prompt evaluation — batch-01

`batch-01` contains at most one deterministic source message for each of 806
supplied callsigns on `echo-skhid`. It uses the evaluation's frozen window from
2026-08-08 17:54:24.574648 UTC through 2026-08-10 08:27:08 UTC, matches active
primary callsigns exactly, selects the earliest message for each match, and
deduplicates messages shared by multiple requested callsigns.

The gitignored `raw/batch-01/` directory contains the input `callsigns.txt`,
the three-column evaluation corpus `callsigns.csv`, the requested-callsign to
message mapping `matches.csv`, and `unmatched.txt`. Run:

```bash
ai-eval/2026-08-10-callsign-prompt/extract-batch.sh batch-01
python3 ai-eval/2026-08-10-callsign-prompt/validate-batch.py \
  ai-eval/2026-08-10-callsign-prompt/raw/batch-01
```

The result contains 62 matched callsigns in 62 unique messages and records 744
unmatched callsigns without fuzzy or cross-server substitution. The corpus is
64,852 bytes with SHA-256
`80920d8d5da627d2d046bdb23de535900e494707b4ba0c226bbb48473571c0aa`.
All four batch artifacts were uploaded and checksum-verified under
`s3://echouastorage/lfs/echo-ai/evals/2026-08-10-callsign-prompt/batch-01/`.

The completed human review is preserved separately as
`raw/reviews/batch-01.csv` with SHA-256
`f059c38d84a75b895e9d73ec038376ced928e85e8de06d221679603cc543ad0b`.
It contains 62 reviewed rows; 47 differ from the initially parsed callsigns.
