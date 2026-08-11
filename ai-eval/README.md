# AI evaluation artifacts

Each evaluation lives in a dated directory named `YYYY-MM-DD-name`. Prompts,
notes, extraction tools, examples, and memory are tracked in Git. Raw
production-derived corpora live only in the evaluation's gitignored `raw/`
directory and in Backblaze B2 under:

```text
s3://echouastorage/lfs/echo-ai/evals/<evaluation>/
```

Fetch or upload a corpus without deleting remote objects:

```bash
just ai-eval-sync-from-cloud <evaluation>
just ai-eval-sync-to-cloud <evaluation>
```

Exported `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` take precedence. If
only one or both are missing, `ai-eval/sync.sh` fills only the missing values
from the repository `.env`. The commands require `s5cmd` and use the shared B2
S3 endpoint.
