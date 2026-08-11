# Evaluation tools

`prepare.py` reads the sources in `datasets.json`, strips the single NUL from
the unfinished trailing WIP record while parsing, skips rows without an
expected value, applies source precedence, and excludes unresolved duplicate
transcripts. It writes canonical and focused datasets under `raw/prepared/`.

`evaluate.py` calls an OpenAI-compatible Chat Completions endpoint with
temperature zero, normalizes output like the production worker, checkpoints
every response under `raw/runs/<run>/`, resumes safely by prompt checksum, and
reports exact rows, false positives, false negatives, invalid responses,
precision, recall, and F1 by split, case kind, and source dataset.

`compare.py` prints a compact table for one or more raw `metrics.json` files.
Raw review inputs, prepared corpora, responses, and metrics are synchronized to
B2 by the evaluation-level sync command.
