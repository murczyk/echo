# Message attachment indexing

Only `signal_message_media` is indexed. The Device file registry (`wd_files`)
is independent. Search uses PostgreSQL full-text indexes and the existing
`pg_trgm` extension; no embedding service or vector database is needed.

The document extractor produces canonical HTML, Markdown and bounded source
sections for DOCX, XLSX/XLSM, PPTX, text, CSV, JSON and XML/HTML. LibreOffice
converts DOC/RTF/ODT, XLS/ODS and PPT/ODP in a filesystem and network sandbox.
ZIP/RAR/7z members retain their names. Embedded images and PDFs use the OCR
pipeline. Existing completed OCR is reused for image/PDF attachments. Map
attachments reuse the existing KMZ conversion worker. Unsupported members,
failed OCR, archive limits and incomplete coverage remain visible.

Archive limits: 1,000 members, two archive levels, 1 GiB expanded data,
250 MiB per input, 20 million extracted characters and one million table
cells. Native parsers run in a separate process with memory, CPU and time
limits. Embedded OCR is bounded by the extractor's page limit. A focused
original inspection can request `page N` of a PDF beyond that coverage.
Macros and external spreadsheet links are not evaluated. Formula text and
cached values are both retained.

## Workers and administration

`/admin/ai/documents` controls indexing, automatic summaries and position
matching, with separate text engines. All are paused when indexing is off.
Extraction runs separately from summaries, position matching and original
inspection. The settings initially disable indexing and position matching.
Enable the desired stages explicitly after deploying the extractor.

Discovery walks all retained media newest first, with a persistent cursor.
New uploads enter the queue immediately and are prioritized by creation time.
The cursor's completion means discovery finished, not that every job finished.
Jobs use leases, bounded retries and generation checks. Source replacements
invalidate old chunks; explicit reprocessing preserves the last readable
revision until its replacement is ready. Read requests can pin a revision.

Job pickup uses `attachment_job_claim_idx(kind, created_at DESC, id)` for queued,
retrying and running jobs, then checks due time, lease expiry, current document
generation and message deletion before claiming one row with `SKIP LOCKED`.
Migration `m20261022_090303_attachment_job_claim_index` builds the source-only
index concurrently. Check free space and long-running transactions before
deployment; inspect `pg_stat_progress_create_index` and index validity afterward.
No analytics resnapshot is required. An application rollback can retain the
index; remove it only through the migration rollback after reverting the app.
See [index verification and interrupted-build recovery](#claim-index-recovery).

Every source chunk gets its own summary; large documents are reduced through
successive summary batches rather than a first-N-character cutoff. Coordinates
come from original text. Position matching also reads original chunks, including
OCR, and uses the existing grounding, access scopes and known-position linking.
Message cards receive nullable `coordinateStatus` containing the published
attachment revision and whether it has coordinates. Maps read current chunks
through `GET /api/messenger/media/{media_id}/summary/coordinates`, independently
of summaries. An empty published revision suppresses stale legacy points; only
attachments without a published revision fall back to legacy media summaries.
WGS84 values retain their precision and coordinate system.

Retry from the document admin page re-extracts a source under a new generation.
If its OCR or map conversion failed, retry that underlying job in its existing
admin/preview controls as well. Position feedback requeues the document's
position stage without discarding its extracted text. Disabling a stage pauses
pending work; queued jobs resume when re-enabled.

## Search and harness

Message search includes bodies, attachment names and indexed contents by
default. Existing frequency, UID and quoted-substring syntax is preserved.
The attachment API searches only matching documents, respecting the current
message/group permissions and deletion/archive flags:

- `POST /api/attachments/search`: query, groups, message IDs, format, optional
  millisecond dates and a seek cursor. Results include summary, source snippet,
  coverage and processing states. No implicit date cutoff.
- `POST /api/attachments/get`: metadata and summary; optionally request sections.
- `POST /api/attachments/read`: bounded sections, Markdown, sanitized HTML,
  coordinates and continuation ordinal; pin `revision` across pages.
- `POST /api/attachments/inspect-original`: bounded asynchronous reprocessing
  of the original; select an archive member or source locator as needed.
- `POST /api/attachments/inspection-status`: poll an authorized inspection.

The harness registers these focused tools, keeps parent-message citations and
source locators, and preserves continuation pointers when fitting results into
context. Originals are processed by the extraction service; the harness has no
shell or arbitrary URL/file access. Pending or unsupported sources are not
proof that a subject is absent. Document contents remain untrusted evidence.

## Rollout and recovery

### Claim index recovery

Run these read-only checks on the intended source database after the concurrent
build, or after a failed/interrupted migration:

```sql
SELECT indexrelid::regclass AS index_name, indisready, indisvalid,
       pg_get_indexdef(indexrelid) AS definition
FROM pg_index
WHERE indexrelid = to_regclass('public.attachment_job_claim_idx');

SELECT pid, phase FROM pg_stat_progress_create_index
WHERE index_relid = to_regclass('public.attachment_job_claim_idx');

SELECT version FROM seaql_migrations
WHERE version = 'm20261022_090303_attachment_job_claim_index';
```

The valid definition must index `(kind, created_at DESC, id)` on
`public.attachment_job` with the queued/retry_wait/running predicate. This is
index-only DDL with an empty analytics-impact declaration: it changes no
replicated columns, requires no entity regeneration, and must not trigger a
table or mirror resnapshot.

A failed concurrent build can leave an invalid index with the same name. Once
the build has stopped, and after explicit approval naming the host and index
repair, drop only that invalid index with a standalone
`DROP INDEX CONCURRENTLY public.attachment_job_claim_idx;`, then retry the normal
migration runner within the approved scope. Do not wrap either concurrent index
operation in a transaction or drop an active/valid index as automatic recovery.
If the index is valid but its migration record is absent, stop and reconcile the
definition and migration state with the operator; a duplicate-name error is not
proof of a completed migration. Obtain separate approval for recovery outside
the original operation's scope.

### Attachment pipeline rollout

1. Deploy the updated `echo-document-extractor` application to the intended
   extraction host. Its package adds LibreOffice, libarchive, libseccomp and
   bubblewrap. Verify its native attachment job and existing OCR job paths.
   A staging extractor must use its own spool and queue. Set Echo's
   `ATTACHMENT_EXTRACTOR_URL` to its native API endpoint; regular OCR continues
   using `[ocr].base_url`. The native API uses the same configured bearer token.
   An isolated native worker can delegate embedded images to an existing OCR API
   through `ECHO_NATIVE_OCR_BASE_URL` and `ECHO_NATIVE_OCR_TOKEN`, without changing
   that API's deployed code or loading a second set of OCR models.
2. Deploy Echo with migration `m20261005_050621_attachment_documents`. The four
   attachment tables and position tables are excluded from analytics; ship the
   updated exclusions before migrations using the normal deployment procedure.
3. Upgrade only the intended harness namespace to `2026.10.05.2`, following
   [the control panel procedure](../../../echo-ai-agent/CONTROL_PANEL.md).
4. Choose summary and position engines in `/admin/ai/documents`, then enable
   extraction. Check queue progress and sample Office, archive and OCR sources.
   Test a main-page request whose answer exists only inside an attachment.

Pause indexing in the admin page before rolling back an application. Keep the
schema and encrypted artifacts for a forward fix; a down migration deletes
this derived index and its chunk-specific position mentions. Re-enable indexing
after recovery and retry failed documents. Archive or parser limits intentionally
leave coverage incomplete; use a focused original inspection or split the source.

Extractor fixtures: `echo-document-extractor/tests/test_documents.py` and
`echo-document-extractor/tests/test_service.py`. Database authorization,
revision and matching regression: `wdintel-rs/src/attachments/tests.rs`.

### Reindex completed stored OCR

Use the deployed binary and production mode on the intended host:

```bash
/usr/bin/wdintel-rs --mode=live oneoff-reindex-stored-ocr --media-id <UUID>
/usr/bin/wdintel-rs --mode=live oneoff-reindex-stored-ocr --media-id <UUID> --yes
```

The first command is a dry-run: it checks that the image/PDF has an attachment
document and usable completed OCR artifacts, then prints the extracted coordinate
count. `--dry-run` overrides `--yes`. Apply queues only that attachment through
the regular retry logic; extraction reuses stored OCR without calling the OCR
provider. Indexing must be enabled. The previous readable revision remains until
publication; each publication changes `coordinateStatus.revision`, invalidating
map previews. No summary must finish for the coordinates to become available.

Run individually for each reported attachment, checking queue progress, current
revision and map points after each. Stop if service, ingestion or analytics health
fails. Keep the previous application package for rollback; follow the deployment
health and rollback procedure before attempting further recovery.
