# Prompt variants

- `production-2026-08-10.txt` is the byte-for-byte 4,102-character production
  baseline captured before iteration.
- `candidates/01-evidence-gated.txt` reduces false positives by requiring
  stronger evidence for numbers, dictated data, ordinary nouns, and speech
  fragments. It is the selected prompt and matches `../prompt.txt`.
- `candidates/02-role-gated.txt` is a less conservative recovery experiment.
  It improved recall but had more total item errors than candidate 01 on the
  development split, so it was not selected.

Add future candidates without replacing earlier files. Use a new raw run name
for every prompt checksum; the evaluator rejects accidental resume with a
different prompt.
