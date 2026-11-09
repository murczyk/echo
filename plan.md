# Documentation media in Backblaze — #3938

Source: [idea.md](idea.md). Stage 1 implementation is authorized; stages 2 and 3 remain deferred.

Implement stage 1 first: normalize media paths, retain packaged media, add authenticated local delivery with a Backblaze fallback, and provide the requested default-off B2-only setting. Stage 2 removes source/package media and adds a six-hour cache refresh. Making B2-only delivery the permanent default remains an optional stage 3.

The uploader processes every server using its existing S3 destination and credentials. Following read-only verification, the user chose not to add namespace configuration: servers with the same bucket share `doc-media/` objects. Existence checks and forced uploads still run per server; no credentials or permissions are changed.

## HOWTO

Keep implementation work in `Open Items` as a checkbox list. Check items as they are completed, add new items when new required work appears, and remove the plan file once all items are complete and there are no unresolved questions.
Put any blocking or review-needed questions in `QnA`; add your suggested answers. If a question is answered, fold the answer back into `Open Items` as concrete work or a concrete decision, then remove the answered question. Do not delete the plan file while `QnA` still has unresolved questions. If all QnA items are resolved and there are still some Open Items - start implementing those items; if some questions arise durins the implementation so you're blocked with the solution of a current open item - pause the execution and ask user to answer them.
Example `Open Items` usage:

- [ ] Add a focused regression test for the failing scenario.
- [ ] Implement the smallest code change that satisfies the test.
- [x] Confirm the relevant helper already handles empty input.

Example `QnA` usage:

- [ ] Should the migration backfill old rows or only affect new rows?
  - Suggested answer: backfill old rows if the user-facing UI depends on consistent historical data.

## Open Items

### Stage 1: paths, uploads, and local fallback

- [x] Inspect release rendering, documentation generation, Debian assets, nginx routing, S3 storage, and versioned system settings. The current branch supplies issue reference #3938.
- [x] Identify existing sources: `docs/releases/**/media/` contains PNG and MP4 media; `docs/static/` contains documentation PNG and MP4 media. Documentation themes also contain SVG and ICO assets, and release-authoring instructions support WebM. `wdintel-web/static/releases` is a symlink to `docs/releases`, so the frontend build currently copies release text and media together.
- [x] Resolve the storage-access decision: read-only verification found `echo-pivnich` uses bucket `echouastorage` and its key has no filename-prefix restriction. Attachment code adds only `message-media/`. The user chose to keep existing configuration without adding per-server namespaces; use `doc-media/` in each configured bucket and process every server independently.
- [x] Accept the remaining decisions: route captures are repository-relative paths after `/doc-media/`; B2-only delivery streams through the authenticated endpoint without local persistence.
- [x] Establish one mapping shared by the uploader, packaging, frontend, and backend. Proposed contract, preserving existing Cyrillic filenames and spaces:

  | Purpose | Example |
  | --- | --- |
  | Repository-relative media path | `docs/releases/2026-10-29/media/ланцюжки.mp4` |
  | Object key in the configured bucket | `doc-media/docs/releases/2026-10-29/media/ланцюжки.mp4` |
  | S3 destination for a server using `echouastorage` | `s3://echouastorage/doc-media/docs/releases/2026-10-29/media/ланцюжки.mp4` |
  | Browser URL | `/doc-media/docs/releases/2026-10-29/media/<percent-encoded filename>` |
  | Route capture after `/doc-media/` | `docs/releases/2026-10-29/media/ланцюжки.mp4` |
  | Local file | `/usr/share/echo-docs/docs/releases/2026-10-29/media/ланцюжки.mp4` |

  Documentation media follows the same mapping with `docs/static/<filename>`. Use the configured bucket and apply `doc-media/` exactly once; encode URL path segments without changing object names. No server-name prefix is inferred. Define the base directory, media prefix, and operational limits in `wdintel-rs/src/config.rs`, with an isolated local-development directory override.
- [x] Add `just release-doc-media` using the credential/tool checks and S3-compatible upload approach in `goi/justfile`'s `release` recipe. Default source roots are `docs/releases` and `docs/static`; preserve repository-relative paths beneath `s3://<configured-bucket>/doc-media/`.
- [x] Make the just recipe explicitly iterate over every unique server in the existing `active_servers` inventory and upload the full selected media set separately to each destination. Resolve each server's actual bucket, endpoint, region, allowed root, and existing credentials through the existing private configuration mechanism; do not assume GOI's credentials can access these destinations or derive storage roots blindly from SSH aliases. Use the configured bucket exactly as the attachment code does; add only `doc-media/`, with no inferred server-name prefix. Servers using the same destination share the existing objects. Preflight all target configurations before uploading and keep credentials out of command output and tracked files.
- [x] Support `just release-doc-media --only <directory>` and `--force`, independently or together. `--only` replaces the default roots and retains recursive traversal and repository-relative keys; validate that its directory exists inside the checkout. Quote paths safely for spaces and Unicode, and exclude symlinks that escape the selected source.
- [x] Declare the media-extension allowlist explicitly in the recipe: `mp4`, `webm`, `jpg`, `jpeg`, `png`, `mp3`, `gif`, `svg`, and `ico`, matched case-insensitively. Exclude Markdown, JSON, text, CSS, JavaScript, and fonts. Keep backend eligibility consistent. Theme assets remain outside the default source roots; explicitly selected media can use these extensions.
- [x] Check object existence independently inside each server's destination and upload only absent keys by default, regardless of local size or modification time. An existing copy in a distinct destination must never suppress another destination's upload; servers configured for the same destination independently observe and skip its existing keys. `--force` overwrites every selected media object on every target; `--only` applies the same selected source set to every target. Do not delete remote objects. Distinguish missing objects from listing/authentication/network failures, reject unresolved Git LFS pointers, and report per-server totals plus an overall summary. Attempt the remaining targets after an individual target fails, then exit nonzero if any target failed; reruns skip successful copies without rolling them back.
- [x] Build documentation-media plaintext S3 access from each server's existing S3 configuration and credentials using the OpenDAL/S3 construction primitives in `wdintel-rs/src/storage.rs`, using `doc-media/` in its configured bucket. Keep documentation reads separate from the attachment prefix, encryption/decryption, and StrongBox initialization. Missing S3 configuration must preserve startup and packaged local delivery, emit a warning, and produce a clear unavailable response when remote access is required. Do not provision new credentials or broaden existing permissions.
- [x] Add a focused `doc_media` backend module and register `GET`/`HEAD /doc-media/{storage_key:.*}` in `wdintel-rs/src/server/mod.rs`. Validate the existing session and required user access before inspecting local files or contacting B2; unauthenticated requests must receive an authorization error.
- [x] Restrict requests to supported documentation-media roots and extensions. Reject absolute paths, traversal, backslashes, invalid encodings, and filesystem/symlink escapes; validate decoded paths consistently. Do not allow arbitrary reads from `/usr/share/echo-docs` or other B2 prefixes.
- [x] Implement local-first delivery: serve an existing regular file; on a genuine miss, download from B2 to a temporary file in the destination directory, atomically publish it, and serve it locally. Coalesce concurrent misses per key, bound remote concurrency/timeouts, stream large files, and remove incomplete downloads. Distinguish local I/O failures, remote absence, and remote service failures.
- [x] Preserve browser media behavior in local and B2-only modes: correct content types, inline playback, `HEAD`, byte ranges including `206`/`416`, content length, and validators. Use private caching with revalidation so the authenticated route is revisited and future six-hour refreshes are observable.
- [x] Move release-media Debian assets from `/usr/share/echo/releases/...` to the normalized subtree under `/usr/share/echo-docs/`. Update `wdintel-rs/Cargo.toml` and the frontend build/static-copy arrangement to separate media from `index.json` and `release.md`; keep release text available at the existing `/releases/` URLs. Stage 1 retains media in the checkout and Debian packages.
- [x] Package documentation source media under the matching `docs/static/` subtree while preserving the generated Zola site's HTML and theme assets. Review `docs/echo-docs/Cargo.toml` and `deploy/ci/build_debs.sh` so the two packages do not claim the same files. Ensure package upgrades preserve runtime-downloaded media and that the service can create cache directories without broad permission changes.
- [x] Update `wdintel-web/src/ts/react/routes/updates/releases.service.ts` and its Markdown consumers to resolve relative media through `/doc-media/`; preserve external URLs, query strings/fragments, and release-text loading, and avoid encoding or prefixing resolved URLs twice. Review existing legacy Elm release APIs for any affected consumer.
- [x] Update documentation media references and `docs/templates/shortcodes/{img,video}.html` to use the same endpoint for local documentation images/videos. Preserve external embeds and normal document navigation.
- [x] Add `/doc-media/` proxy routing to the applicable `deploy/nginx/echo-*` configurations and the documented development nginx setup. Forward cookies, `HEAD`, and range headers to the backend. Prevent the new media subtree from bypassing authorization through the existing `/docs` filesystem alias or frontend static routing; preserve ordinary documentation and `/releases/` metadata routes.

### Stage 1: B2-only system setting

- [x] Add nullable `system_settings.doc_media_serve_from_b2 boolean` with no database default in a new timestamped raw-SQL migration; register it in `echo-migration/src/lib.rs`. Treat `NULL`, an omitted request field, or absent active settings as `false`. Follow comparable migrations and provide a matching down migration.
- [x] Declare the migration's analytics impact in `deploy/clickhouse/migration-impact.json`. Use an appropriate additive strategy with a reviewed, bounded update to publish the new column on `system_settings`; verify the populated/empty-table behavior and avoid a mirror resync.
- [x] Wire the property through current/list/create/activate settings flows in `wdintel-rs/src/system_settings/{types,mod}.rs`, preserving historical settings versions. Regenerate entities with `just gen-seaorm` and frontend contracts with `just gen-front`; do not hand-edit generated entities or backend types/encoders/decoders on the frontend.
- [x] Add the default-off administrator switch in `wdintel-web/src/ts/react/routes/admin-system-settings-neo/` and its API adapter, using generated backend types and the existing save/activate and error-display behavior.
- [x] When enabled, authenticate normally and read exclusively from B2 without reading, writing, or falling back to local media. Stream through the authenticated endpoint. A B2 failure must remain visible; disabling the setting restores local-first delivery without deleting cache files.

### Stage 1: validation and documentation

- [x] Add focused #3938 regressions and critical safeguards for authorization before I/O, traversal/symlink rejection, local hits without remote access, missing-file downloads, concurrent/failed download cleanup, unavailable storage, and B2-only operation despite an existing local copy. Cover settings persistence/default-off compatibility with database-backed production flows.
- [x] Validate the actual just recipe's multi-server orchestration with local target configurations and a local object-store substitute: two servers with distinct destinations both receive the complete selected set; a file present on only one destination is still uploaded to the other; duplicate inventory entries do not cause repeated uploads; `--force`, `--only`, and their combination apply to every destination. Cover per-target credentials/root selection, extension filtering, Unicode/spaces, LFS pointers, and partial failure reporting with a nonzero overall exit. Do not upload to real buckets for validation without explicit approval naming the operations and destinations.
- [x] Verify Markdown media rendering and settings save/reload in Vitest, authenticated local/B2 delivery and settings activation in backend regressions, and cookies/ranges/HEAD/cache protection with isolated local nginx instances. Execute affected Playwright suites: all 14 tests across the five affected settings suites passed; all 22 focused Vitest tests passed.
- [x] Apply migrations only to an isolated local database and run `just migrate-up`, `just gen-seaorm`, and `just gen-front`. Restore the standard test dump with `source deploy/setup_test_database.sh 3938-doc-media`, then run `GITHUB_BASE_REF=<confirmed-base-branch> TEST_DB_NAME="$DB_NAME" scripts/ci/check_analytics_migration_catalog.sh`. Confirm the actual base branch before this check; do not infer it from `HEAD^` or change branches.
- [x] Run focused validation: 4 backend, 4 uploader, 22 Vitest, and 14 Playwright tests passed; `cargo check`, production `cargo clippy -- -D warnings`, the frontend/Zola builds, and the catalog-aware analytics migration check passed. Verify the real `s5cmd` against isolated local S3, including its empty-listing error, existing-key skipping, force, Unicode/spaces, and per-server processing. Extract locally built application/docs packages and verify all 49 media files byte-for-byte, preserved release metadata, no old public release-media copies, and no conflicting package ownership. Apply formatting without unrelated diffs. The broader `cargo clippy --all-targets -- -D warnings` check reports a pre-existing unnecessary cast in `wdintel-rs/src/devices/files/content/async_replay_tests.rs:621`; that unrelated file remains unchanged.
- [x] Update focused media-authoring/operations documentation and `docs/CHANGELOG_INSTRUCTIONS.md` with upload commands, per-server path mapping and existing storage configuration, the setting, and failure/recovery behavior. Explain that one command publishes to every configured server root, and a new server needs its own initial media upload. Add a #3938 `CHANGELOG.md` `NEXT` entry with 👷 instructions for required configuration/nginx actions. Leave overview READMEs unchanged unless their existing architecture/setup description becomes inaccurate.
- [x] Write the durable high-level implementation overview to `archive/2026-11-06-3938-release-notes-b2/plan.md`, including stage boundaries and agreed decisions, before retiring this temporary working plan.
- [x] Prepare a concrete stage-1 rollout checklist: run the prepared just recipe against the explicitly approved server inventory, populate and verify each server's own B2 media prefix with its existing credentials, install the prepared packages and nginx routing on explicitly named targets, then validate authenticated local-hit, missing-file, and B2-only paths. Request explicit approval for the named real bucket/prefix/server operations only after local implementation and validation; this planning request authorizes none of them. A partial upload failure must identify incomplete destinations for a separately scoped retry.

### Stage 2: remove bundled media and refresh after six hours

Deferred until separately requested after stage-1 deployment.

- [ ] After stage 1 is deployed and remote completeness is verified separately for every server root, remove only migrated documentation/release media from the current checkout and package/build inputs, adjusting the release symlink/copy path, CI Git LFS requirements, and Zola media handling as needed. Preserve release Markdown/index files, source documentation, theme assets, and Git history. Ensure an upgrade removing package-owned files can recover every media object from that server's B2 prefix.
- [ ] Refresh cached media on demand when its last successful download/revalidation is at least six hours old; download immediately on a miss. Track freshness independently of remote object age and reproducible package mtimes. Use conditional requests where supported, atomic replacement, and per-key coordination; keep failures from marking stale files fresh. Define bounded retry behavior and stale-file policy before implementation.
- [ ] Cover the six-hour boundary, replacement after running `release-doc-media --force` across all targets, concurrent refreshes, failed refreshes, and cache-free upgrades with focused #3938 regressions. Confirm that each server observes its updated B2 copy on its first request after its refresh window; idle servers refresh when requested. Changing an object in one distinct B2 destination does not update other destinations; servers using the same destination share the replacement.
- [ ] Document and validate the stage-2 release sequence and recovery, then obtain separate approval naming its bucket/environment mutations before performing them.

### Stage 3: optional permanent B2-only delivery

Deferred; requires a separate scope decision.

- [ ] Revisit availability, latency, bandwidth cost, and whether delivery should stream through Echo or redirect to short-lived signed URLs. The stage-1 switch supplies a way to evaluate B2-only operation; permanently removing the local-cache path or making B2-only the default requires a separate decision and scope.

## QnA

No unresolved questions.
