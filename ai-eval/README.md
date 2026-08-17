# AI evaluation artifacts

Each evaluation lives in a dated directory named `YYYY-MM-DD-name`. Prompts,
notes, extraction tools, examples, and memory are tracked in Git. Raw
production-derived corpora live only in the evaluation's gitignored `raw/`
directory and in Backblaze B2 under:

```text
s3://echouastorage/lfs/echo-ai/evals/<evaluation>/
```

Fetch or upload every corpus without deleting objects on either side:

```bash
just ai-eval-sync-from-cloud
just ai-eval-sync-to-cloud
```

To sync only one corpus, pass its dated directory name without the `ai-eval/`
or `archive/` prefix:

```bash
just ai-eval-sync-from-cloud 2026-08-09-document-ocr-evaluation
just ai-eval-sync-to-cloud 2026-08-09-document-ocr-evaluation
```

Both directions are incremental. Upload-all scans local evaluation
directories with a non-empty top-level `raw/`. Download-all discovers
evaluation prefixes in Backblaze and restores unknown ones under
`ai-eval/<evaluation>/raw/`.

Sync compares file sizes instead of modification times because S3 uploads and
downloads do not preserve compatible local timestamps. Treat synchronized raw
artifacts as immutable: a same-path, same-size content change is not detected,
so write such a revision under a new filename.

Exported `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` take precedence. If
only one or both are missing, `ai-eval/sync.sh` fills only the missing values
from the repository `.env`. The commands require `s5cmd` and use the shared B2
S3 endpoint.
