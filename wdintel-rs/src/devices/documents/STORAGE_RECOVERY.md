# Native extractor storage pressure

HTTP 507 from `http://127.0.0.1:18080/v1/jobs` means the native extractor
rejected admission because its spool limit or free-space floor was reached.
Check the extractor limits and the filesystem inside the container, then the
host ZFS pool; the HTTP status alone does not identify which limit was hit.
Echo defers HTTP 429, 503 and 507 submissions without consuming the five-attempt
failure budget. Other submission errors retain the existing retry behavior.

## CBR capacity and rollout

This procedure targets `echo-cbr` (CT 126 on `pve-hz-3`) only. Its 10 GiB spool
cap was reached while the container and host still had free space. The shared
GPU extractor and staging have independent limits and are outside this rollout.

An accepted local job can also fail during OCR with an upstream 507 from
`http://100.93.77.92:8000/v1/jobs`. That error comes from the shared GPU
extractor and requires separate capacity recovery there. This procedure does
not retry already accepted jobs or repair the upstream GPU service.

1. Save the current `wd.device_document_settings` row, eligible `wd_files`
   document/job rows, native configuration and an online SQLite backup in a
   root-only directory. Disable only the device pipeline's `enabled` flag and
   wait for outstanding leases to finish. Published results remain readable.
2. Check available space in the container and host ZFS pool. In
   `/etc/echo-native-extractor/config.yaml`, set `service.limits.max_spool_bytes`
   to `53687091200` (50 GiB). Preserve `min_free_bytes: 21474836480` (20 GiB)
   and `retention_seconds: 604800` (seven days, also the native default).
   Preserve this local override when regenerating the native configuration.
   Do not delete retained results or resize the disk for this incident.
3. Restart `echo-native-extractor-api.service` and
   `echo-native-extractor-worker.service`. Require HTTP 200 from
   `http://127.0.0.1:18080/health/ready` and a fresh worker heartbeat. Validate
   a small text submission through completion before resuming processing.
4. Deploy the tested backend to CBR. No schema migration or frontend change is
   introduced by this fix. For a worker-only hotfix, save the installed binary
   and package version, validate the new binary's checksum and build identity,
   replace `/usr/bin/wdintel-rs` atomically, and restart only
   `wdintel-rs-bgworker.service`. Existing web processes remain available.
   Record the replacement checksum and source commit beside the backup; the
   package manager still reports the previous package version until a regular
   package deployment replaces the hotfix. Keep a copy of the previous backend
   for rollback.

## Recover rejected submissions

While the device pipeline is paused, inspect and back up the rows selected by
[`recover_storage_pressure.sql`](recover_storage_pressure.sql). Run that query
in a transaction against **`wd_files`** with `ON_ERROR_STOP=1`, a bounded lock
timeout and a bounded statement timeout. Verify the returned count against the
backup before committing; a mismatch requires investigation and rollback.

The query selects only failed `extract` jobs whose current-generation document
is also failed, whose lease fields are empty, whose payload has no
`extractorJobId`, and whose error contains the exact localhost HTTP 507 URL.
It clears the error and attempt count and queues the same job and document.
It preserves their IDs, revisions, generations, published results and the
backfill cursor. It does not retry accepted native jobs, stale generations,
leased work or unrelated errors.

Restore only the saved device pipeline `enabled` flag; leave engine selections,
summary and position flags unchanged. Observe jobs acquiring an extractor ID
and completing, with no new storage-pressure failures. The backlog drains
asynchronously; recovery does not mean that every document has completed.

Monitor spool usage, filesystem free space, host pool capacity, oldest queued
job age and new HTTP 507 responses during the seven-day retention window. The
50 GiB cap must remain below the usable filesystem capacity minus the 20 GiB
floor and other service growth. Reassess capacity if pressure returns.

## Rollback

Pause the device pipeline and restore the previous compatible backend atomically,
then restart the background worker if the code deployment fails. Keep the
validated 50 GiB limit unless configuration
validation failed: restoring the old 10 GiB cap would immediately block new
submissions. Preserve completed results and generations. If a recovered job
has already progressed, do not overwrite it with its pre-recovery snapshot.
Restore the pipeline's previous enabled state once the backend is healthy.
