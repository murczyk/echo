# Upload finalization benchmark

This harness exercises the actual Echo API, background worker, PostgreSQL migrations,
Redis sessions and a private MinIO container. Python 3.11+ is required. It does not
start the web frontend, transcription providers or external forwarding destinations.
The API and every supporting service bind to loopback; ordinary development services
and databases are left alone.

## Start through Orca

Build `cargo build --locked -p wdintel-rs` in an Orca terminal first. The stand records
the binary SHA-256 and Git commit. The current harness uses the debug binary; its
absolute timings are not production or release performance estimates.

Prerequisites: native PostgreSQL with PostGIS, Redis, ffmpeg, Docker, the standard
`deploy/wd_test-2025-08-17-07-43.pgrestore` dump, and the locally available MinIO image
used by `file_preview_harness.py`.

```sh
python3.13 scripts/devices/upload_benchmark_stand.py prepare --capacity-profile throughput
```

Save the printed private directory as `BENCH_ROOT`. Then:

```sh
orca terminal create --worktree current --title 'Upload benchmark stand' \
  --command "python3.13 scripts/devices/upload_benchmark_stand.py serve --root '$BENCH_ROOT'" --json
python3.13 scripts/devices/upload_benchmark_stand.py status --root "$BENCH_ROOT"
```

Wait for `stage: ready`. `api_a_port` identifies the API. Credentials and encryption
keys remain in private files under the run directory. The stand imports the standard
dump, migrates both databases, disables imported external clients and registers a
dedicated user. Original PostgreSQL files and private logs remain after stopping.
The fixture raises the API rate-limit burst to 10000 with a one-millisecond replenish
interval, and disables automatic transcription so these do not mask finalization costs.
The owned MinIO container and its objects are removed on stop: run the audit first.

Both capacity profiles enable async admission and keep the standard execution slots,
job budgets and one-second idle worker polling. To fit a local workstation they set the
file maximum to 256 MiB, reserved bytes to 1 GiB and minimum free spool space to
512 MiB. `defaults` preserves the standard upload count quotas. `throughput` raises
the global and per-user upload count quotas to 4096, so deferred source cleanup does
not stop the finalization comparison after 32 uploads. The 60-second file cleanup
setting is unchanged; async source cleanup runs after finalization and falls back
to the one-second async poll interval. These are test settings, not deployment recommendations.

## Send files or audio

```sh
python3.13 scripts/devices/upload_benchmark.py \
  --base-url "http://127.0.0.1:$BENCH_PORT" --credentials "$BENCH_ROOT/credentials.json" \
  --kind file --mode async --input /path/to/file.bin --output /tmp/file-upload.jsonl

python3.13 scripts/devices/upload_benchmark.py \
  --base-url "http://127.0.0.1:$BENCH_PORT" --credentials "$BENCH_ROOT/credentials.json" \
  --kind audio --mode sync --input /path/to/recording.mp3 --output /tmp/audio-upload.jsonl
```

Use `--count`, `--concurrency` and `--sizes` for generated payloads. Every generated
upload contains distinct deterministic bytes; audio is valid mono 8 kHz PCM WAV.
The tool validates TUS offsets, polls async jobs respecting Retry-After, and rejects
foreign upload locations and redirects. It checks downloaded file SHA-256 and audio
detail visibility. It performs no hidden HTTP retries. Failed attempts remain in
JSONL and cause exit status 1; setup failures produce no summary. Output is never
overwritten. Keep two GiB of free local disk space or adjust `--min-free-gib` deliberately.

## Run a matrix

```sh
orca terminal create --worktree current --title 'Upload benchmark runs' \
  --command "python3.13 scripts/devices/upload_benchmark_suite.py --root '$BENCH_ROOT' --profile full --output target/upload-benchmark/full-new" --json
```

Profiles:

| Profile | Each of the four kind/mode combinations |
|---|---|
| `smoke` | 4 uploads, concurrency 2 |
| `full` | 24 at concurrency 1, 512 at concurrency 8, 32 at concurrency 16 |
| `large` | 4 at concurrency 2; files alternate 8/128 MiB, audio is 8 MiB + WAV header |

`full` is 2272 attempts. The suite alternates cohort order and captures API/worker/
PostgreSQL/Redis RSS, process CPU readings and free disk every second. MinIO and
short-lived ffmpeg processes are not included in those RSS measurements. Use
`--resume` only to skip recorded cohorts against the same stand; incomplete cohort
files are intentionally not overwritten. A completed cohort with rejected requests
does not stop the remaining comparisons.

Metrics use nearest-rank percentiles. `ack_seconds` measures `/complete` or `/receive`;
`publication_seconds` extends through terminal job polling. Async `server_job_seconds`
comes from the server's created/finished timestamps and avoids polling quantization.
Publication can precede observation by about one polling interval. Phase metrics
in the audit use `before_winning_attempt_seconds` for the interval from admission
to the winning storage attempt: it includes queueing, source preparation and any
earlier retries, so it is not a pure queue-wait measurement. `winning_attempt_seconds`
covers that attempt through publication. Earlier audit files called these fields
`queue_seconds` and `processing_seconds`; retain this distinction when comparing them.
Latency summaries
describe successes; `ack_seconds_including_rejections` also includes rejected
finalization requests. Throughput is closed-loop completed operations over the whole
cohort, including upload, polling, verification and failed attempts. It is not the
worker's isolated maximum capacity. File verification downloads all original bytes;
audio detail verification is lighter, so compare modes within a kind.

## Integrity, cleanup and retry checks

The independent audit reads published S3 objects, authenticates/decrypts strong-box
envelopes and compares every plaintext byte count and SHA-256 with the client receipt.
It also checks async quotas, source release, unresolved writes and multipart sessions,
and downloads/decodes a playback sample for each audio size and mode.

```sh
uv venv --python python3.13 target/upload-benchmark/audit-venv
uv pip install --python target/upload-benchmark/audit-venv/bin/python \
  'boto3==1.42.38' 'cryptography==46.0.4'
target/upload-benchmark/audit-venv/bin/python scripts/devices/upload_benchmark_audit.py \
  --root "$BENCH_ROOT" --results target/upload-benchmark/full-new \
  --output target/upload-benchmark/audit-new.json
```

Run this after workloads have drained; auditing during load contaminates timing and
can report genuinely active reservations. All successful samples are verified even
when other benchmark requests failed. Failures stay visible and are never counted
as successful transfers. The audit may need the normal cleanup interval to elapse.

`upload_benchmark_recover.py --root ... --results ... --output ...jsonl` sequentially
retries finalization of sources that were fully uploaded before rejection. It never
retransmits bytes or changes the original measurements. Rejections before upload
creation are skipped. A consumed/expired source returns 404 and requires a new upload.
Recovery metrics must not be merged into the original throughput measurements.
An audio PATCH can write every byte and then return 503 while waiting to promote
the TUS source. HEAD then reports the full offset although `/receive` still returns
404. For an unacknowledged transfer with the full offset, recovery sends an empty
PATCH at that offset before finalization, recording `tus_completion_http_status`.
PATCH 404 can mean promotion already finished; finalization still has to confirm
success. Partial transfers and uploads rejected before creation require resumption
or a new upload; this utility does not retransmit their payload.

```sh
python3.13 -m unittest discover -s scripts/devices -p test_upload_benchmark.py
python3.13 scripts/devices/upload_benchmark_stand.py stop --root "$BENCH_ROOT"
```

Stop validates the supervisor's process identity. The supervisor stops only children
it created and removes only its labelled MinIO container. It does not drop databases
on another PostgreSQL instance or delete other worktrees' files.
