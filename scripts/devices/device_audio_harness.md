# Device audio local test environment

Use Python 3.11+ (on this macOS checkout, `python3.13`), PostgreSQL with PostGIS,
just, cargo, Node/npm, redis-server, ffmpeg/ffprobe, lsof and local Docker.
The standard `deploy/wd_test-2025-08-17-07-43.pgrestore` dump and image
`quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z` must already exist.
Run `npm ci` and `npx playwright install chromium` in `wdintel-web` first.

`prepare` prints a private temporary root. `PG_USER`, `PG_PASSWORD`, `PG_PORT`
override the local test credentials; the restore role must be able to create
PostGIS. Use an existing local role with that permission; do not grant extra
privileges to the application role to run these tests.

```bash
python3.13 scripts/devices/device_audio_harness.py prepare
python3.13 scripts/devices/device_audio_harness.py start --root /absolute/root/from/prepare
source /absolute/root/from/prepare/environment.sh
cd wdintel-web
npx playwright test tests/e2e/device-audio.spec.ts
cd ..
python3.13 scripts/devices/device_audio_harness.py stop --root "$AUDIO_TEST_ROOT"
```

Every run has separate wd/wd_files databases, signed/encrypted local S3,
Redis, storage/cache, two API listeners, frontend/proxy and ASR fixture ports.
Only the API processes run; general background integrations are not started.
The devices section is enabled and the fixture is registered as the only active
GPU provider in the copied test database. No model or external GPU is contacted. The global transcription
switch starts disabled; scenario setup controls it explicitly.

`stop` also works after partial startup and retains private logs. A failed run
must be stopped and prepared again; start never replaces an existing process.
Cleanup verifies private configuration hashes, database ownership markers,
Docker labels and PID lifetimes/process groups before removing resources.
Preview and audio roots cannot be interchanged. Do not edit the private config
or ownership manifest after preparation.

The ASR fixture implements the pinned echo-gpu health, multipart upload,
checksum lookup and guess endpoints. Its token is in `$AUDIO_TEST_ROOT/asr-token`.
Pass it as `X-Fixture-Token` to the Rust-port control endpoints:

- `POST /__fixture/control`: JSON `mode` is `success`, `no_speech`,
  `safe_rejection` (404 before inference), `delayed`, `lost_response`, or
  `chunk_error`. Optional `delay_seconds` is 0–300; `fail_on_guess` selects the
  failing request since the most recent control change (default 2).
- `GET /__fixture/state`: upload/request/inference/completion counters, current
  and maximum concurrency, and start/completion events keyed by provider audio ID.

Control changes preserve cumulative counters and do not cancel work already
running. A timed-out client leaves delayed inference active. Lost response
finishes inference then closes without a response. A later chunk error returns
500 after the earlier chunks succeeded; it does not simulate safe cancellation.
These fixtures prove local state-machine behavior, not real GPU execution.

Harness safeguard checks (real scratch processes/databases) and protocol checks:

```bash
python3.13 scripts/devices/test_device_audio_harness.py
python3.13 scripts/devices/test_device_audio_asr_fixture.py
python3.13 scripts/devices/test_file_preview_ownership.py --database
```
