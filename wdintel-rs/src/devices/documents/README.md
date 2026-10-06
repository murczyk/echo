# Device documents

The agent searches synchronized device metadata and file revisions that the
current human may read. Names remain searchable without uploaded content.
Extraction reads existing `file_content` objects from the private S3 store;
it never requests an upload or connects to a source device.

## Access and source identity

Device access requires the enabled Devices section, an active user and organism,
and the existing Cyber or Admin read permission. API agents resolve
their linked human on every request. Existing organization hierarchy rules apply.
Search defaults to active devices and current file revisions; archived devices
and history require explicit options. Historical sources remain readable while
the user retains device access.

A citation identifies device, file and file revision, with optional immutable
extraction generation and section ordinal. Follow the returned `citation` URL;
keep `extractionRevision` when following `nextAfter`. Reprocessing creates another
generation without changing existing citations. Revision aliases retain the
generation originally reused from unchanged uploaded content. Preview, inspection
polling, agent follow-up context, and map reads/exports recheck access. Revoked
sources are excluded from subsequent agent context.

## Storage and processing

All derived data lives in **`wd_files`**: extraction text, Markdown, sanitized
HTML, full-text and trigram indexes, summaries, coordinates, grounded position
mentions, warnings, extraction generations, revision bindings, inspection
results, jobs and the incremental backfill cursor. The primary database contains
only small pipeline settings and source references in existing chat/map records.

Four tasks in the existing background-worker process handle extraction,
summaries, positions and focused inspection. The pipeline defaults to disabled.
Enabling summaries and positions also requires a selected enabled text engine.
Disabling an enrichment stage leaves its jobs queued for later enablement.

New `file_content` inserts enqueue work transactionally in `wd_files`. A persisted
keyset scan discovers older content in batches of 100. Workers claim jobs with
`SKIP LOCKED`, 15-minute renewable leases and at most five failed attempts.
Polling an external extraction job does not consume the failure budget. Writes
check the current generation and lease, preventing a replaced worker from
publishing stale results. Extraction reuses only complete, fully enriched results
for the same uploaded content, extension and parser version.

The shared native document extractor handles supported Office, PDF, text, image
and archive formats. KML/KMZ uses Echo's map parser. Audio and video are unsupported.
Source size, extracted size, archive traversal and section limits use the shared
attachment extraction bounds. Truncated packages remain explicitly incomplete.
Focused page/table/OCR/image inspection uses its own queued job and immutable
generation; it does not replace the searchable extraction.

## Retrieval and evidence

The seven agent routes cover device discovery/detail, file search/get/read,
original inspection and inspection status. They are exposed only when device
access and the optional file-registry schema are available. Admin settings and
retry endpoints are not agent tools.

Search scopes are `name`, `content`, `summary` or `all`. Name/path matching treats
`%` and `_` literally. Content uses Russian full-text stemming plus a literal
substring match; `all` also searches archive member names. Results have a stable
file/revision keyset cursor, a maximum page size of 50 and a five-second query
timeout. File reads return at most eight sections with separate continuation.
Missing uploads, queued/failed/unsupported extraction and incomplete coverage
must not be interpreted as absence of evidence.

File search `from`/`to` filter file modification time in UTC milliseconds. They
are not observation dates. Extracted positions retain exact file/section sources
and have no inferred observation date. Position lookup groups device evidence
with message knowledge only within the same currently accessible AOR. Private
message groups and devices without AORs retain separate scopes. Conflicting
coordinates lower group confidence. Context compaction drops groups whose
supporting sources no longer fit, preserving individual source citations.

Map scripts can read delivered sections through `inputs.files()` or
`inputs.texts()`. Passing a section as `source` to `records.Record` preserves the file citation;
the section's observation datetime stays empty. The sandbox receives only
sections already returned by authorized tool calls.

## Rollout and recovery

1. Deploy matching backend/frontend with the standard migration sequence for
   both the primary database and `wd_files`. Primary migration
   `m20261006_082251_device_document_settings` is excluded from analytics.
   Files migrations `m20261006_082251_device_documents` and
   `m20261006_082252_file_history_search` add the derived tables and historical
   filename index. The latter builds its index concurrently; allow time and disk
   space proportional to the existing revision catalog.
   If that build is interrupted, inspect `pg_index.indisvalid` for
   `file_revision_name_trgm_idx` in `wd_files`. Drop only an invalid leftover
   index with `DROP INDEX CONCURRENTLY file_revision_name_trgm_idx`, then rerun
   the normal migration sequence.
2. Ensure the existing native attachment extractor and private S3 settings work,
   then restart API and background-worker processes. Preserve the S3 encryption
   key used for existing content. Deployments without a file registry keep
   existing chat/message tools operational.
3. Upgrade only the intended harness instance to `2026.10.06.1` using the
   [control panel](../../../../echo-ai-agent/CONTROL_PANEL.md). Run its dry-run
   compatibility check first.
4. In **ШІ → Документи**, enable the device pipeline and select engines for the
   desired enrichment stages. Observe discovered-content progress and job-state
   counts. Metadata-only devices have no extraction work until content exists.
5. Check an authorized current file, a historical revision, multi-section
   continuation, a pinned chat citation after reload, and a revoked user's source
   access before expanding deployment.

To pause processing, disable the device pipeline in the same panel. Existing
published results remain readable. Use the per-document retry control for failed
or outdated extraction; it creates a new generation and preserves the previous
published one until replacement succeeds. Inspection status exposes failure
details. Inspect `file_document.last_error` and `file_document_job.last_error`
in `wd_files` for worker failures; do not copy extracted data into the primary DB.
Normal retry preserves the backfill cursor. No table reset is required.

For rollback, disable processing and restore the prior compatible application
and harness release using the control-panel recovery procedure. Keep the new
tables and immutable generations so existing sources can be recovered. A schema
down migration deletes derived evidence and should not be used for routine
rollback.

Regression coverage: `wdintel-rs/src/devices/documents/tests/authorization.rs`,
`wdintel-rs/src/devices/documents/tests/lifecycle.rs`,
`wdintel-rs/src/devices/documents/tests/maps.rs`,
`wdintel-rs/src/devices/documents/tests/positions.rs`,
`echo-ai-agent/runner/devices.test.ts`,
`echo-ai-agent/runner/map-script.test.ts`, and
`wdintel-web/tests/e2e/ai-agent-files.spec.ts`.
