# Echo Document Extractor

Local-first semantic extraction for PNG/JPEG and PDF documents. The extractor
reconciles geometry/OCR evidence with NuExtract3 and Gemma output, then writes a
canonical HTML document and projections to Markdown and XLSX. Production runs
as an authenticated, durable asynchronous service on
`http://100.93.77.92:8000` inside `ct-echo-document-extractor`.

```bash
uv sync --extra cpu --extra dev
echo-doc extract scan.pdf --output raw/result --config config.example.yaml
echo-doc validate raw/result
```

Separate images require a manifest containing an ordered `inputs` list. API
tokens are read from the endpoint `token_env` variables and are never stored in
configuration or output artifacts.

Use `config.split_gpu.yaml` for the recommended independent router pools at
`100.105.172.96:8001` (OCR-Gemma) and `100.105.172.96:8002` (NuExtract3).
`config.single_spark.yaml` is a serial, benchmarking-only profile. Paddle
evidence is required in production; `enable_paddle: false` is only a local
degraded mode.

Packages are written atomically into a new or empty private directory. They contain
canonical HTML, Markdown, optional XLSX, typed provenance and quality records,
lossless SHA-256-named assets, and private page images for `echo-doc inspect`.

## Service API

Only `/health/live` and `/health/ready` are unauthenticated. Every `/v1` route
requires `Authorization: Bearer …`; submissions also require an
`Idempotency-Key`.

- `POST /v1/jobs`: multipart `files` plus optional `manifest` JSON; returns
  `202` with the durable job record.
- `GET /v1/jobs/{id}`: queue state, attempts, timestamps, progress, quality,
  and a bounded error summary.
- `GET /v1/jobs/{id}/result`: completed canonical ZIP package.
- `DELETE /v1/jobs/{id}`: requests cancellation at a page boundary or deletes
  a terminal result.
- `GET /v1/status`: queue, worker, storage, Paddle, and exact router-model
  status.

`/health/ready` checks queue/storage availability. Verify full OCR readiness
with `bin/verify-clients.sh echo-cbr-staging echo-cbr`, which checks the worker,
Paddle, and required router models in the authenticated status response.
NuExtract GPU maintenance and its dependency alert are documented in the
[host runbook](../echo-vllm-router/workers/nuextract/MAINTENANCE.md).

Manifest version one remains the compatibility path and uses the statically
configured NuExtract3 plus OCR-Gemma adapters. Version two may carry an opaque
Echo-issued OCR gateway grant and engine metadata; the extractor then uses
NuExtract3 plus the gateway-selected semantic engine. It never receives or
stores an engine credential. Paddle remains local supporting evidence in both
paths.

Queue states are `queued`, `running`, `retry_wait`, `completed`, `failed`, and
`cancelled`; extraction quality remains independently `accepted`, `degraded`,
or `failed`. SQLite uses WAL, one worker owns up to two leases with heartbeats,
and abandoned jobs are recovered after restart. Paddle calls remain serialized
inside the worker. Infrastructure failures receive three backoff retries.
Terminal data is retained for seven days.

The service accepts at most 250 MiB and 200 pages/files per job, holds at most
25 active queue records, and runs up to two jobs at a time. Admission stops at 70 GiB
of spool data or below 20 GiB free; unexpired jobs are never evicted to admit a
new request. Rasterization and extraction are page-serial, duplicate rasters
are processed once, and large artifacts spill to private disk before atomic
package creation.

## Development and checks

```bash
uv sync --extra cpu --extra dev
uv lock --check
uv run ruff check .
uv run pytest -m 'not live'
```

The committed `uv.lock` resolves CPython 3.13 and pins PaddlePaddle `3.3.1`
CPU development and CUDA 12.6 production runtimes with
`paddleocr[doc-parser]` `3.7.0`. PP-StructureV3 is therefore installed with its
required parser dependencies and a separate PaddlePaddle inference runtime.
Production uses `gpu:0` in an `echo-gpu` Incus container and points every model
at an immutable checksummed model set; startup is validated with networking
disabled.

## Build and deploy

The Debian 13 `amd64` builder is `echo-build-deb13-main` and must have the
version of `uv` pinned in `versions.env`. The application package contains only
source, `uv.lock`, service/configuration files, pinned deployment tools, and the
SigNoz collector. It does not contain Python dependencies or Paddle models.

To prepare the initial model tree on a trusted GPU-capable host:

```bash
uv run python bin/prepare-models.py \
  --cache /var/cache/echo-document-extractor/paddlex-cache \
  --output /var/cache/echo-document-extractor/models
```

Publish it once with a write-capable Backblaze key. The publisher uploads the
checksum manifest last, so a partially uploaded set cannot become active:

```bash
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... just publish-models
```

This runs against `/var/cache/echo-document-extractor/models` on the Debian 13
builder. `just publish-models-local` is available when `MODEL_SOURCE_DIR` is
present on the operator machine. Read-only credentials cannot publish the
initial model set.

Normal builds and deployments need only the read-only
`ECHOUASTORAGE_LFS_RO_*` credentials already stored in the repository `.env`:

```bash
just package
just preflight
just deploy
just verify
just verify-clients
```

At deployment, `uv sync --frozen` creates a versioned GPU environment below
`/opt/echo-document-extractor/runtime` only when the lock hash changes. Wheels
remain in `/var/cache/echo-document-extractor/uv`. Model objects are downloaded
from the prefix in `/etc/echo-document-extractor/models.env`, keyed by SHA-256,
materialized as a read-only versioned set, and activated atomically. Existing
objects, environments, and successful offline Paddle gates are reused. A code-
only redeploy therefore transfers only the small application package and does
not reinstall Python or copy 1.6 GiB of models. The first transition can reuse
the verified files from the legacy model package without downloading them
again.

The installer creates `/etc/echo-document-extractor/secret.env` with a random
bearer token, owner `root:echo-document-extractor`, mode `0640`. The repository
contains only a blank example. Non-secret settings live in
`/etc/echo-document-extractor/config.yaml`.

Deployment installs an isolated native nftables table inside the extractor Incus
before the API starts. TCP `8000` on `tailscale0` is allowed only from the
seven Echo source addresses in `config/firewall-sources.conf`; all other
sources are denied without changing unrelated host firewall rules.
Administrator SSH, Tailscale transport, and extractor-to-router egress remain
available, and bearer authentication remains mandatory. `just preflight`
confirms every host still uses its recorded source address before deployment;
update the allowlist and redeploy if an address or private transport changes.

## Telemetry and rollback

The API and worker expose Prometheus metrics on loopback `29000` and `29001`.
The pinned SigNoz collector exports API, queue, duration/status, page, Paddle,
model/token, retry, spool, cleanup, process, host, and journald telemetry with
`service.name=echo-document-extractor` and
`host.name=ct-echo-document-extractor`. Host CPU time comes from a loopback
exporter on `127.0.0.1:9100` (`echo_host_cpu_seconds_total`) rather than the
hostmetrics CPU scraper, which latches after Incus reassigns `limits.cpu`.
Filenames, contents, and job IDs never become metric labels.

Rollback installs a retained application package; lock-keyed runtimes and
manifest-keyed models remain locally cached:

```bash
PREVIOUS_APP_DEB=/path/app.deb just rollback
```

Stopping or rolling back these units does not alter any Echo instance or vLLM
router. The previous Proxmox CT 130 on `echo-mothership-01` is additionally
retained powered off as the host-level rollback for the initial migration to
the GPU-backed Incus instance on `echo-gpu`; never start both copies of the
preserved Tailscale identity at once.
