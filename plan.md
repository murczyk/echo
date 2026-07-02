# GOI Palitra Integration Upgrade Plan

## Plan

- [x] Treat the GOI SSH palette folder as the source of truth for current GOI palette inventory; use the existing SSH list/download helpers in `wdintel-rs/src/organism/goi/mod.rs` and derive metadata from filenames/KMZ contents because there is no GOI palette metadata API for now.
- [x] Add central constants for supported palitra upload extensions: `kmz`, `kml`, `gpx`, `trk`, `ldk`, `geojson`, `rte`, `wpt`, `are`; keep `pgd` explicitly rejected with a code comment that PGD conversion is not stable enough yet, so Echo does not permit it for now.
- [x] Add a pure SQL migration for palitra import/conversion state, including status fields such as `ready`, `processing`, and `error`, source format/source filename, conversion receipt, last conversion error, retry counters/timestamps, `missing_in_goi bool not null default false`, `imported_from_goi bool not null default false`, and a durable conversion job queue consumed by the reports/bgworker service.
- [x] Add a pure SQL migration for GOI palette tracking, keyed by `goi_integration_id` plus remote relative path and/or remote stable id, with local `palitra_id`, direction/source (`echo` or `goi`), remote status, last seen timestamp, checksum/size/mtime when available, last sync error, and retry metadata.
- [x] Add a persisted GOI setting, default `true`, that disables propagating palitras from GOI to Echo.
- [x] Add `maintainer_login` to GOI integration, referencing `login(login)`, so imported GOI palitras can use that login as `palitra.author`.
- [x] On startup, ensure every GOI integration has `maintainer_login`; if missing, assign the oldest live account from the owner organism, fall back to an inactive user from that organism or any Admin if needed, and write to errlog when auto-assigning.
- [ ] Register migrations in `echo-migration/src/lib.rs`, run `just migrate-up`, and run `just gen-seaorm`.
- [x] Refactor AlpineQuest conversion code in `wdintel-rs/src/alpine/mod.rs` into reusable backend helpers that accept bytes, filename, content type, hide-title options, and output format, returning converted KMZ bytes plus resolved filename.
- [x] Add palitra conversion processing to the existing reports/bgworker entrypoint (`wdintel-rs/src/server/mod.rs` / `wdintel-rs/src/report_history.rs`) instead of launching ad hoc `tokio::spawn` conversion tasks.
- [x] Register exactly one palitra conversion worker thread per bgworker process, process conversion jobs sequentially, and use DB locking/advisory locking if needed so only one conversion job runs at a time.
- [x] The reports/bgworker conversion thread should process queued non-KMZ uploads, call the reusable converter, keep only the conversion receipt after successful conversion, parse the resulting KMZ through the existing `palitra::kmz` path, update palitra geometry/points/line strings/S3 id, and move status to `ready`.
- [x] On conversion failure, keep the palitra visible with status `error`, no geometry, the original file metadata, and the last error; do not enqueue GOI upload until conversion succeeds.
- [x] Add backend retry action for failed palitra conversion jobs, guarded by the same author/Admin palitra management permission used by point uploads.
- [x] Update `/api/palitra/analyze-kmz`, create-with-file, basic create, advanced create, and upload-points paths to accept all allowed extensions; keep immediate parsing for KMZ/KML where possible and queue conversion for other formats.
- [x] Rename frontend wording from KMZ-only to file/palitra upload where needed in `wdintel-web/src/ts/react/routes/rer-palitra-neo`, and configure file pickers to accept `.gpx,.trk,.ldk,.geojson,.rte,.wpt,.are,.kml,.kmz`.
- [x] Show palitra status in the palitra table and map-related surfaces: processing rows should be selectable/manageable but have no geometry; error rows should show last error details; `missing_in_goi` palitras should show a red warning sign near the name with a tooltip explaining that the palette is missing in GOI.
- [x] Add a Retry conversion action to the palitra row actions dropdown for palitras in `error` state.
- [x] Extend generated backend/frontend types through `wdintel-rs/src/elm.rs` and `just gen-front` so status, source format, and retry action responses are not hand-written in Elm/TS bindings.
- [x] Add a checkbox in GOI settings for "disable propagating palitras from GOI to Echo", checked by default, and wire it to the persisted GOI setting.
- [x] Add `maintainer_login` editing to the admin GOI integration UI so maintainers can be changed later.
- [x] Extend outbound GOI upload completion handling so successful uploads update the GOI palette tracking table with integration id, remote path, local palitra id, upload status, and observed remote file metadata when available.
- [x] Extend the GOI sync worker to list each configured GOI server's palette files, reconcile them against GOI palette tracking rows, and update `missing_in_goi` for Echo-uploaded palitras: `false` when present, `true` when the tracked remote file is missing.
- [x] Make the GOI sync worker skip GOI-to-Echo imports when the GOI settings checkbox is checked, while still tracking Echo-to-GOI upload statuses.
- [x] During GOI sync, detect remote GOI palette files that are not tracked; if the remote filename matches an Echo-uploaded palitra filename pattern, link it to the existing palitra tracking row instead of importing a duplicate.
- [x] For each downloaded GOI-only palette that cannot be linked, create imported Echo palitra rows with `imported_from_goi = true`, `author = goi_integration.maintainer_login`, derive names from filenames, and derive colors from KMZ contents or existing defaults.
- [x] When an imported GOI-only file contains multiple colors, keep it as one Echo palitra with per-color geometries, matching the current advanced KMZ behavior.
- [x] For imported GOI-only palitras, set access to the GOI integration owner organism plus all extra access organisms/logins configured on that GOI integration.
- [x] If an imported GOI-only file is not KMZ/KML, queue it through the same palitra conversion worker used by user uploads; if conversion fails, keep the palitra in `error` state and preserve retry capability.
- [x] Implement duplicate/conflict rules around the resolved linking behavior: matching Echo-uploaded filenames link to existing palitras; non-matching files import once per GOI integration plus relative path.
- [x] Ensure folder handling preserves GOI relative folders where useful, mapping them to Echo palitra `folder` when safe.
- [ ] Add targeted Rust tests for extension validation, queued conversion state transitions, retry behavior, GOI tracking reconciliation, inbound access derivation, and duplicate handling.
- [ ] Add targeted frontend tests for upload accept list, processing/error status rendering, and Retry action visibility.
- [x] Run `cargo fmt`, `cargo check`, focused `cargo test`, `cargo clippy`, and `just build-front`.

## QnA

- No open questions.
