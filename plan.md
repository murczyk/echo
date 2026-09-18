# SIGINT attachment-to-KMZ conversion handoff

## Requested behavior

- On creation of a SIGINT inbox item, create one background conversion job for
  each newly uploaded attachment supported by `/alpinequest-kmz`.
- Store the source message ID, media ID, original file name, content type, and
  MD5 in the job.
- Convert globally one file at a time.
- Do not attach the converted KMZ to the message.
- In `/rer-duty-neo`, `/rer-analysis`, and `/rer-analysis-neo`, clicking the
  original attachment must open a popup that previews the converted KMZ and
  shows buttons for downloading the original and converted files.
- The converted download name is `<original-stem>_converted.kmz`.

## Findings

- `/rer-palitra-neo` already has the reusable pieces: a persistent conversion
  job pattern, Alpine conversion client, KMZ coordinate parser, and Leaflet
  preview styles/layers.
- The extensions advertised by `/alpinequest-kmz` are `ldk`, `trk`, `are`,
  `rte`, `wpt`, `set`, `kml`, `kmz`, `geojson`, `gpx`, and `fit`.
- New SIGINT uploads are persisted through
  `sigint/direct_submit/bl.rs`; this is the scheduling point used. Edits to an
  existing message do not schedule new jobs under the current implementation.
- `/rer-duty-neo` and `/rer-analysis-neo` share the React message-card path.
  `/rer-analysis` uses `Shared/Components/RerMessage.elm`, so a React custom
  element is used there to share the same popup implementation.
- Existing media authorization can be reused for converted status, preview,
  and download endpoints. Converted files remain encrypted objects in S3.

## Completed work

### Database and generated entities

- Added migration
  `echo-migration/src/m20260917_150626_signal_message_media_conversion_job.rs`.
- Added `signal_message_media_conversion_job`, with message/media foreign keys,
  unique source media, source MD5, source metadata, status/attempt fields,
  conversion receipt, converted object key/name/size, and timestamps.
- Registered the migration and generated/connected the SeaORM entity.
- Declared the new operational table as excluded from ClickHouse replication
  in `tables-exclude.txt` and `migration-impact.json`.

### Backend scheduling, worker, storage, and API

- New module: `wdintel-rs/src/sigint/media_conversion/`.
- New-message uploads with a supported extension create one job per successfully
  stored file. MD5 is calculated from the uploaded source before it is removed.
- The worker:
  - uses a PostgreSQL session advisory lease around the whole conversion;
  - prechecks for pending/stale work so it does not reserve a connection while
    idle;
  - updates the processing heartbeat every 60 seconds and recovers jobs stale
    for five minutes;
  - verifies the stored source MD5 before conversion;
  - limits source reads to 200 MiB;
  - stores the converted KMZ encrypted in S3 without creating message media;
  - uses attempt guards to prevent stale workers from overwriting newer work;
  - removes a newly stored result if the final database update fails or loses
    the attempt race.
- Added authenticated status, converted-preview, and converted-download routes.
  They require the RER role and the same message/media access check as original
  attachments.
- Deleting an attachment through direct submit captures and removes its
  converted S3 object after commit on a best-effort basis.
- Registered the worker and routes in the server.
- Reused the existing Alpine conversion client and Palitra KMZ parser by making
  the necessary modules crate-visible.

### Frontend

- Added `kmzConversionStatus` to generated media bindings and inbox response
  normalization.
- Added the conversion status/preview/download API client.
- Added a shared React popup with:
  - original and converted download buttons above the preview;
  - status polling while conversion is pending/processing;
  - converted KMZ geometry rendered on the same Leaflet/OSM-style preview used
    by Palitra;
  - inline errors, toast errors, retry, empty-geometry state, and loading state;
  - converted download disabled until the job is done.
- Wired the popup into the shared React message card for `/rer-duty-neo` and
  `/rer-analysis-neo`.
- Added a custom element and wired it into the Elm message renderer for
  `/rer-analysis`.
- Convertible attachments are excluded from the normal document preview path,
  so clicking the original consistently opens the converted KMZ popup.
- Updated affected mocks and attachment constructors.

### Documentation

- Updated `docs/README.md` with job ownership, sequential worker behavior,
  storage, authorization, and cleanup details.

## Verification completed

- Resolved the rebase conflicts in `echo-migration/src/lib.rs` and
  `deploy/clickhouse/migration-impact.json` by retaining both chronological,
  additive migrations. `GIT_EDITOR=true git rebase --continue` completed the
  rebase successfully; no conflict markers remain and nothing was pushed.
- Backend checks passed:
  - `cargo check -p wdintel-rs`;
  - `cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings`;
  - focused database-backed media conversion tests against a fresh standard
    test dump: 2 tests passed;
  - `cargo fmt --all -- --check` and `git diff --check`.
- Added database-backed regression coverage for supported-file scheduling,
  stored message/media/MD5 identity, exclusive worker leasing, sequential
  claims, and stale-attempt protection.
- Frontend checks passed:
  - `just build-front`;
  - `npx tsc --noEmit`;
  - focused Vitest run: 3 files, 18 tests;
  - `npm run format:staged` (no staged frontend files).
- Added a popup regression test covering the converted preview, both download
  targets/names, and the requirement that download controls precede the map.
- Re-ran the catalog-aware migration check after the rebase against a fresh
  database restored from the standard test dump; it passed with both the
  upstream migration and this branch migration in the resolved order.
- The pre-existing default local test database remains unsuitable because it
  contains schema state from another branch. All database-backed checks above
  used fresh databases restored from the required standard test dump.
- No Mattermost notification was sent because the workspace has no `.env` hook.

## Current state

- The feature implementation is in the rebased branch history. The rebase is
  complete and the index has no unresolved conflicts.
- The new regression tests and this updated handoff are uncommitted. No push
  was performed.

## Remaining work

1. Perform a manual end-to-end smoke test in an environment with configured S3,
   Alpine conversion service, an authenticated browser, and representative
   SIGINT data, using at least two convertible files:
   - create a SIGINT inbox item;
   - confirm one job per file with message ID and MD5;
   - confirm jobs execute sequentially and results are not message attachments;
   - open the original file in all three requested routes;
   - confirm the popup previews the converted result and both downloads have
     the expected contents/names;
   - delete an attachment and confirm converted-object cleanup.
   This cannot be completed in the current local test environment because its
   S3 and Alpine/browser integration dependencies are not configured.
2. Consider adding converted-route authorization integration coverage before
   merge; scheduling and worker concurrency are now covered.
3. Decide whether this feature needs a `CHANGELOG.md` entry. If it does, obtain
   the GitHub issue number first and follow the project changelog skill/rules.
4. Review and commit the uncommitted regression tests and handoff update only
   after explicit permission. Never push without explicit permission.
