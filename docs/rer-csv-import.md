# Admin RER CSV imports

`/admin/rer-csv-import` imports each valid single-column CSV record into the
selected group. Preflight checks timestamps and message size; duplicate checks
run during import, against current PostgreSQL state.

An active message is already imported when its full stored body equals the
incoming body and a `signal_message_group` link names the selected group.
CSV normalization trims outer whitespace and converts CRLF to LF. Internal
whitespace, case, headers, and explicit date/time text remain significant.
Sender, uploader, filename, primary datasource group, and parsed timestamp do
not affect duplicate identity. Identical time-only text remains a duplicate
with a later reference date. Matches confined to other groups allow a new
import. Deleted messages also allow a new import, except tracked split parents
with an active child inbox. Existing duplicate data is left in place; lookup
prioritizes completed imports, then legacy inboxes, before recovering an
interrupted match. Message ID breaks ties within each processing state.

The background-task log identifies duplicate source-record numbers and message
IDs. Its summary reports `total`, `imported` (new messages), `reused` (interrupted
messages recovered), `skipped` (invalid rows and completed duplicates),
`duplicates`, `missing_timestamp`, and `invalid_message_size`. Successful tasks
satisfy `total = imported + reused + skipped`. Validation reason counts can
both include the same invalid row.

## Retry behavior

Message insertion, UID assignment, group linking, and recovery registration
commit together under a group/body advisory lock. A separate per-message lock
serializes processing and rechecks completion after waiting. Inbox construction,
metadata, parsing queues, group reconciliation, search, and the durable list of
changed inbox IDs commit together in a second transaction. Failures roll back
these writes and fail the import task; uploading again reuses the original
message ID, timestamp, and reference time.

Fanout runs after the inbox transaction commits. A durable completion timestamp
is written only after fanout succeeds. If fanout or its completion write fails,
retry sends the saved changes without reconstructing the inbox or resetting its
review state. Notifications can be delivered more than once across a crash;
message and inbox writes are not repeated. Split parents remain discoverable
through their saved child inbox IDs, including before delivery completes; once
all children are deleted, the source can be imported again. Completed duplicates
are never reprocessed or updated.

Imports predating this safeguard have no processing marker. Existing messages
with an inbox row are conservatively skipped to preserve reviewed data; this
does not certify that every historical processing step succeeded. A legacy
message without an inbox can be recovered using its stored timestamp and the
retry's reference time. Historical partial inboxes need an explicit repair;
re-uploading does not silently reset them.

The safeguard applies to explicitly targeted admin imports. Default-group CLI
and Delta imports keep their existing matching and processing behavior.

## Deployment and verification

Apply `m20261009_100730_rer_csv_body_index` and
`m20261009_100730_rer_csv_processing` before starting the updated backend.
The first builds the body MD5 expression index concurrently, including deleted
split parents; exact body comparison remains authoritative. The PostgreSQL-only
recovery table `rer_csv_import_message` is excluded from analytics replication
through the packaged exclusion list and migration-impact declaration. Normal
deployment synchronizes exclusions before applying migrations.

Recovery state must be retained alongside messages. Deleting it removes the
ability to distinguish completed inbox construction from interrupted delivery.
No cleanup or backfill of old duplicates is required.

Database regressions are in
`wdintel-rs/src/rer_importer/import_csv/duplicate_tests.rs`; historical validation,
UIDs, authorization, and CLI coverage remain in
`wdintel-rs/src/rer_importer/import_csv.rs`.
