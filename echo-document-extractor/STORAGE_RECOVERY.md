# Shared OCR storage recovery

The shared service runs in `ct-echo-document-extractor` on `echo-gpu`.
Its GPU deployment uses a **300 GiB root quota**, **200 GiB spool cap**
(`214748364800` bytes), **20 GiB free-space reserve**, **seven-day retention**,
**25 active queue records**, and the existing two concurrent GPU jobs.
`config/service.yaml` owns these GPU defaults. CBR's native runtime separately
uses a **50 GiB** spool cap and its existing single worker; preserve that local
override. Never delete unexpired jobs or rollback backups to admit new work.

## Capacity and deployment

1. Record Incus configuration, installed package and source checksums, settings,
   queue counts, spool usage and free space. Save CBR's
   `device_document_settings.enabled` and `ocr_settings.worker_enabled` flags,
   then pause both. Wait for document leases and extractor work to drain.
2. Take a ZFS snapshot and online SQLite backups with `Connection.backup()`.
   Store incident backups outside the extractor's container quota, for example
   `/incus-backups/ocr-storage-<timestamp>` on `echo-gpu`. Back up selected
   PostgreSQL rows and both settings rows in a private checkpoint directory.
3. On `echo-gpu`, use the supported [Incus volume configuration](https://linuxcontainers.org/incus/docs/main/howto/storage_volumes/):

   ```bash
   sudo incus config device set ct-echo-document-extractor root size=300GiB
   sudo incus exec ct-echo-document-extractor -- df -B1 /var/lib/echo-document-extractor
   ```

4. Set the running GPU configuration's `service.limits.max_spool_bytes` to
   `214748364800`. Preserve the reserve, retention, queue depth and concurrency.
   Deploy the tested application package and restart the drained API/worker.
   Require `/health/ready` and the authenticated `/v1/status` storage and
   router checks to pass. Deploy the tested Python source to CBR's native
   runtime and restart its drained worker. Record source and package checksums.
5. Publish a uniquely versioned stable backend package, deploy it to CBR,
   and verify the installed version and worker binary checksum. No schema
   migration is required. Preserve local configuration and rollback artifacts.

An upstream **submission** HTTP 507 defers the same native job, releases its
lease and reverses that claim's attempt increment. `service.worker.storage_retry_seconds`
is optional and defaults to 60. Cancellation wins over deferral; an expired or
foreign lease cannot update the job. The upstream idempotency key and inputs
remain unchanged. Other HTTP errors and post-admission failures retain their
existing handling. Direct Echo OCR uses dependency postponement for submission
507 without changing attempts, engine snapshots or `discovered_at`, which is
its submission generation.

## Retained native jobs

Run the operator script as root on CBR with PostgreSQL peer access. Its isolated
script dependency is declared for `uv run`; it does not change the application
runtime. Use the exact SQL shipped with this revision:

```bash
sudo uv run echo-document-extractor/bin/recover-storage-pressure.py \
  --checkpoint /var/backups/echo/ocr-storage-<timestamp> \
  --recovery-sql wdintel-rs/src/devices/documents/recover_upstream_storage_pressure.sql \
  --prepare
sudo uv run echo-document-extractor/bin/recover-storage-pressure.py \
  --checkpoint /var/backups/echo/ocr-storage-<timestamp> \
  --recovery-sql wdintel-rs/src/devices/documents/recover_upstream_storage_pressure.sql \
  --batch 10
```

Preparation freezes and backs up the eligible selection. Native jobs must be
retained, failed, uncancelled, unleased, without a published native result,
and have their original inputs. Their recorded error must contain the exact
`Server error '507 Insufficient Storage' for url 'http://100.93.77.92:8000/v1/jobs'`.
Linked Echo jobs and documents must be failed and in the same current generation,
with no lease and the same `extractorJobId`. Source content must still exist.
Stored gateway manifests are excluded: their grants may have expired and need
a separate fresh-generation submission through Echo.

Restore only the saved dispatch flags so the ten canaries can publish through
the normal workers. Require all ten native and Echo jobs to complete. Verify
result checksums and extracted text, including a known image through
CBR → GPU extractor → OCR routers. Then repeat `--batch 20` or use `--drain`
in a supervised asynchronous process. Each batch respects available slots in
the 25-job native queue and revalidates eligibility under PostgreSQL row locks
and a SQLite write transaction. IDs, generations, extractor IDs, input manifests
and previously published document results remain unchanged.

Checkpoints are flushed before mutation. SQLite commits before PostgreSQL so
the native job can progress while Echo rows remain locked. On restart, the
script reconciles a prepared batch using current identities and generations;
it never overwrites jobs that have progressed. Preserve all checkpoints and
re-run the same selection. Never restore entire databases over live work.
`progress.json` records the selected backlog and both queue states; report
remaining jobs explicitly and estimate completion from observed throughput.

## Direct OCR jobs

Back up the selected `ocr_job` and `signal_message_media` rows before updating.
Pre-admission failures must have no extractor ID and the exact submission
error prefix `OCR submission returned HTTP 507 Insufficient Storage:`. Requeue
them with attempts reset and preserve `discovered_at`, engine snapshots and
published HTML. Require the original media source to remain available.

For already accepted GPU storage failures, verify the exact failed GPU job ID
and `StoragePressureError` in its retained queue. Requeue only its current
failed Echo job with a **fresh `discovered_at` generation**, clear its old
extractor ID and submission timestamps, and preserve the selected engine and
published HTML. The normal submission path creates a fresh gateway grant.
Never requeue the stored GPU manifest: grants expire after 15 minutes.

## Monitoring and rollback

`echo_document_extractor_storage_deferrals_total` counts native admission
deferrals; `echo.ocr.storage_deferrals.count` counts direct OCR deferrals.
Observe these alongside spool bytes, free bytes, queue states and new storage
errors. Require 15 minutes without new storage-related failures after the
canaries. Send Mattermost progress with completed/remaining counts and an ETA
based on measured throughput; asynchronous recovery is still outstanding work.

Preview and activate the SigNoz rules with:

```bash
python3 echo-document-extractor/bin/install-storage-alerts.py
SIGNOZ_URL=... SIGNOZ_API_KEY=... python3 echo-document-extractor/bin/install-storage-alerts.py --apply
```

The rules target GPU worker telemetry and the existing `mattermost monitoring`
channel. Spool warning/critical thresholds are 160/180 GiB; free-space thresholds
are below 40/25 GiB, sustained for five minutes. Activation requires an
authenticated SigNoz admin API credential. The installer verifies the stored
rules. See [SigNoz metric alerts](https://signoz.io/docs/alerts-management/metrics-based-alerts/).

If code deployment fails, pause dispatch, restore the previous compatible
package or source, restart the drained services, verify readiness, and restore
the saved flags. Keep the validated capacity increase. Preserve completed
results and reconcile partial batches from their checkpoints.
