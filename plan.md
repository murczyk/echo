# Signal message replies and citation chains

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

- [x] Inspect the existing creation, deletion, refresh, and ingestion paths against `idea.md`.
  - Work is associated with issue #3612, derived from branch `3612-reply`.
  - The standard New Message surface is `routes/shared/manage-message/ManageMessageDrawer.tsx`; it calls `POST /api/1.1/submit-direct`, implemented in `wdintel-rs/src/sigint/direct_submit/`.
  - UI deletion uses `soft_delete_message` in `wdintel-rs/src/rer_importer/inbox/mod.rs`. Foreign-key `ON DELETE` behavior alone cannot handle this path.
  - Live updates use Redis Streams through `event_stream::fanout`, HTTP long polling, and `ETInboxChanged` events. Duty refreshes changed loaded/buffered messages in `useRerDutyFeeds.ts`; Analysis batches reconciliation in `use-targeted-inbox-reconciliation.ts`.
  - Both the pinned `echo-im` revision and the local sibling already expose `MessageF1.reply_to`, including receipts and inbox/outbox provenance. Echo currently drops it in `messenger/worker/mod.rs` when writing `signal_message_queue`. The available sibling is `../echo-im`, rather than `../echo_im`.
- [x] Fold the initial QnA answers into the implementation tasks: deletion tombstones, screen-specific timestamps, automatic group selection, and a single-citation UI backed by collection support.
- [x] Resolve the follow-up questions: deleted replies remain in the chain count, and automatic group fallback applies only to explicit destination-group rejection.
- [x] Define a focused reply behavior/API contract beside the owning component or in `docs/message-replies.md`.
  - Specify direct relationships: fetching a visible message returns its originals and direct replies, without recursively expanding the conversation.
  - Define missing, deleted, inaccessible, empty-body, attachment-only, and missing-timestamp presentations; retain evidence of unavailable endpoints without exposing their content.
  - `message_reply.deleted` means either endpoint was deleted. Return these tombstone relationships, skip their citation-preview queries, and render a cancel icon (an x inside a circle) followed by the warning `Видалено`. Keep inaccessible or not-yet-resolved messages distinct from confirmed deletion. Deleted replies remain in the chain count and render as deleted rows.
  - Define the preview as the first two newline-delimited lines, capped at 256 Unicode characters, with newline normalization. Apply the same contract in the editor and lists.
  - Return both message event time and creation time. The frontend selects the timestamp according to the screen's existing rules: Duty uses creation time; Analysis follows its event/creation-time setting. Changing that preference must not require refetching citation data.
  - Document that adding sender login, attachments, or any other citation metadata requires extending the narrow endpoint and generated types. Do not hydrate full inbox messages to fill those fields implicitly.
  - State explicitly that this release exposes one read-only citation through the card's Reply action. Storage, API payloads, editor state, and rendering accept collections; a UI for selecting or adding several citations is deferred.
- [x] Add a timestamp-named SQL migration in `echo-migration/src/` and register it in `lib.rs`.
  - Create `message_reply` with a stable primary key, nullable `original_signal_message_id` and `reply_signal_message_id` referencing `signal_message(id) ON DELETE SET NULL`, UTC `created_at NOT NULL`, and `deleted BOOLEAN NOT NULL DEFAULT FALSE`. Follow comparable migrations' raw SQL, UTC timestamp convention, error context, and down behavior.
  - Keep rows when either or both messages are physically removed. Prevent duplicate non-null original/reply pairs and self-replies without preventing multiple originals for one reply or retained null endpoints.
  - Ensure deleting either endpoint marks its relationships `deleted = TRUE`, including before physical deletion loses the foreign-key identity. Preserve the rows and surviving endpoints; do not treat this flag as an instruction to filter relationships out of read responses.
  - Index both relationship directions and support deterministic chronological retrieval. Validate the actual access paths rather than relying on the ORM query shape.
  - Persist the normalized messenger reply reference through the ingestion queue, using nullable columns without defaults on existing tables if needed. Include these fields in queue upserts and snapshot-change detection. Preserve enough durable identity to resolve late originals after the initial queue item is consumed.
  - Declare every affected table in `deploy/clickhouse/migration-impact.json`. Classify the new durable relationship table for replication or justified exclusion; queue/support tables must follow their declared exclusions. Do not introduce a full mirror resync for this feature.
  - Apply the migration only to a dedicated local test database restored from the standard dump, then run `just gen-seaorm`; do not hand-edit generated entities.
- [x] Add a small backend reply module shared by manual creation, ingestion, deletion, and read handlers.
  - Implement transactional, idempotent relationship insertion and narrow batched lookup. Keep fallible internal helpers on `anyhow::Result` with source-location context and typed errors at API boundaries.
  - Mark relationships deleted in UI soft deletion, messenger tombstones, and physical deletion. Preserve surviving messages and historical relationships; refresh all surviving affected endpoints and invalidate cached previews immediately.
  - Handle message edits, group moves, duplicate canonicalization/promotion, and source reconciliation so citations show current permitted previews and relationships remain attached to the correct message.
- [x] Add `POST /api/rer-importer/message-replies` and register the handler with the existing inbox API.
  - Request: a deduplicated, bounded set of `signal_message_ids` and an explicit Duty/Analysis screen selector. Put request limits and preview constants in central `config.rs` with a reply prefix.
  - Response: `replies`, containing the relationship rows whose original or reply ID belongs to the requested set, and `reply_messages`, containing deduplicated minimal citation projections for their available endpoints.
  - Each citation projection contains its signal-message ID, nullable event timestamp, creation timestamp, bounded body preview, and screen-specific relative link. Follow the existing `?m=` identifier precedence from `message-card.utils.ts`, including UUID and legacy fallbacks.
  - Authorize requested messages and counterpart projections using the existing group/datasource/owner access rules. Return no deleted or inaccessible message body or usable link; use the agreed unavailable presentation for retained relationships.
  - Include tombstone relationships in `replies`, but do not query citation projections for those relationships. A message still needed by another non-deleted relationship may appear once in the deduplicated `reply_messages` list.
  - Query only required columns, with preview truncation in the database. Avoid full `signal_message`/inbox hydration and per-message queries. Bound anchor batches without silently truncating a message's direct reply chain.
- [x] Extend normal message submission to create replies atomically.
  - Add an optional citation-ID collection to `DirectSubmitPayload`, separate from existing intelligence-report `parent_signal_message_ids` and copy-source relationships. Omission preserves ordinary creation behavior.
  - In `sigint/direct_submit/bl.rs` and its query helpers, validate/deduplicate all cited IDs, access, and the agreed destination group, then create the regular message and one `message_reply` row per citation within the same transaction. Preserve standard parsing, media, tags, statistics, and downstream processing.
  - Prefer the clicked card's authorized group context. When it is ambiguous, select the first eligible source group in a deterministic order and try the next candidate after a qualifying backend rejection until candidates are exhausted. Fall back only after explicit destination-group rejection before any message is committed; stop on other validation errors, authentication failures, timeouts, connection failures, or server errors. Ensure fallback cannot create more than one reply.
  - Log rejected destination candidates and exhausted selection with source/group identifiers and rejection reasons so the ambiguity can be investigated. If no eligible destination succeeds, show an error and preserve the draft; do not ask the user to choose a group or silently submit to an unrelated group.
  - Handle an original deleted between opening and confirming the editor according to the lifecycle decision, without partial message/link persistence.
  - Honor “anybody can reply” for authenticated users who can view the source, including viewer roles currently blocked by `ensure_message_write`/`canWriteMessages`. Add narrowly scoped reply authorization and editor access while keeping ordinary create/edit permissions intact; prevent a reply payload from bypassing unrelated field permissions.
  - Ensure retrying an existing ingestion/creation identity cannot duplicate its relationships. Keep the form populated on submission failure and use the existing error/401 handling.
- [x] Carry native Signal and WhatsApp replies into Echo.
  - Trace `MessageF1.reply_to` through `messenger/worker/mod.rs`, the persisted queue, `messenger::types::Message`, and `message_queue/mod.rs`/worker reconciliation. Use `echo-im` receipt parsers and scoped source identities, rather than matching body text or timestamps.
  - Resolve originals to canonical Echo messages using the source inbox ID and existing duplicate/group mapping. Handle replies arriving before originals, targets never imported into Echo, outbox-only targets, replayed snapshots, and retries without losing the fact that a reply exists.
  - Reconcile pending original references when their targets become available, with bounded indexed work and durable retry state. Preserve an unavailable-original relationship when no Echo target exists.
  - Create relationships and collect invalidations in the same message-processing transaction; publish after commit. Process new incoming messages and subsequent updates without an automatic historical backfill.
  - Change `../echo-im` only if verification reveals missing source identity, unresolved-quote preservation, or change delivery. If changed, follow that repository's guidance, validate both messenger paths, and update Echo's pinned dependency and lockfile together; dependency migrations also need analytics impact declarations.
- [x] Publish reply changes through the existing live event feed.
  - Emit post-commit invalidations for both endpoints on relationship creation/removal and for surviving related messages on endpoint edit/deletion/relinking. Include originals outside the newly loaded page.
  - Reuse `ETInboxChanged` if it can distinguish reply invalidation safely; otherwise add backward-compatible event metadata and update Rust, Elm, and React event handling together.
  - Events mark affected reply data dirty. They must not invoke the reply endpoint directly or cause event-driven message hydration to trigger a new reply fetch on every Redis event. When a refreshed relationship becomes deleted, remove its cached citation preview from that relationship and render `Видалено` without fetching message details.
- [x] Define and generate the frontend API types.
  - Register the Rust reply request/response, relationship, citation, and any event types with `wdintel-rs/src/elm.rs`; run `just gen-front` for both TypeScript and Elm bindings.
  - Add a typed client in `wdintel-web/src/ts/react/services/api/` with wire normalization, cancellation, visible Ukrainian errors, and the existing 401 flow. Use generated backend types rather than manually duplicating them.
- [x] Add shared asynchronous reply state and integrate it with both page loaders.
  - Load reply data after initial, paginated, direct-link, and newly committed message batches without blocking the base message render. Coalesce duplicate IDs across Duty feeds and cache relationships/projections by stable IDs.
  - Keep initial hydration separate from dirty refresh: repeated hydration of an existing message due to a live event must not start another reply request.
  - Duty: integrate with `useRerDutyFeedState.ts`, `useRerDutyPollingCoordinator.ts`, and `useRerDutyFeeds.ts`. Refresh dirty loaded/buffered relationships only when the existing configured polling coordinator permits work, without starting extra count polls.
  - Analysis: integrate with `use-analysis-message-list.ts`, `use-analysis-data.core.ts`, and `use-targeted-inbox-reconciliation.ts`. Respect the existing reconciliation scheduler; it is an event-coalescing mechanism, so add an explicit scheduled reply reconciliation/fallback for currently loaded messages where necessary rather than assuming an existing periodic page reload.
  - Scheduled reconciliation must also discover additions/deletions after missed events or reconnects. Coalesce in-flight work, retain dirty IDs on failure, and apply generation/version guards so stale responses cannot restore removed relationships or overwrite another query/feed.
  - Replace relationship snapshots for refreshed anchors, including empty results. Retain references needed by other loaded messages, prune unused cache entries, preserve identical object references, and refresh a parent when a changed reply preview is already cached.
- [x] Build one reusable citation component for list cards and the New Message editor.
  - Render a quote card with the screen-selected timestamp as small active-theme text in `DD.MM · HH:mm`, followed by regular preview text. Use creation time on Duty and the saved time basis on Analysis; reuse application timezone conventions and the existing screen's missing-time behavior.
  - For a deleted relationship, render only the cancel icon and `Видалено` warning in place of the citation dataframe, with no timestamp, body, link, or detail request.
  - Original-label and timestamp activation opens a confirmation dialog; confirmation opens the screen-appropriate message link in a new tab with opener protection. Unavailable citations have no navigation action.
  - Support keyboard activation, focus restoration, wrapping, light/dark themes, and native semantic structure with shared theme tokens. Keep closed confirmation dialogs unmounted and avoid a separate full-message fetch for each rendered citation.
- [x] Add reply rendering to the shared MessageCard below its tags.
  - Show each cited original under `Оригінальне повідомлення` in active text; support multiple originals, deleted warnings, and unavailable placeholders. A deleted original has no navigation action.
  - Below originals, or directly below tags when none exist, show `Ланцюжок`, a circular count chip, and direct replies ordered oldest to newest by relationship creation time with a stable ID tie-breaker.
  - Render outlined numbered circles starting at 1, thin vertical connectors, and the shared citation card to the right. Apply the selected theme state for the agreed focus/hover interaction; include deleted replies in the count and retain their numbered deleted rows.
  - Preserve native hot-path markup, memoization, stable props, active-only Duty mounts, deferred media, windowing, unread state, and scroll anchors when delayed citation data changes card heights. Review both Duty and Analysis consumers.
- [x] Wire reply actions and composition into both Neo routes.
  - Add `Відповісти` alongside the shared card actions and pass the action through Duty/Analysis list props and memo comparisons.
  - Open the existing `ManageMessageDrawer`/editor surface in reply mode, seeded with a one-element read-only citation collection and the clicked source-group context. Store source IDs independently from editable message content; do not copy the original body into the new body automatically.
  - Ship no multi-selection/add-citation UI in this release. Preserve collection-shaped contracts throughout, and add a concise code comment plus behavior documentation explaining the single-citation UI and intended multiple-citation support.
  - Submit the collection using the automatic destination selection/fallback rule, clear it only on success/cancel, and preserve unsaved-change confirmation, focus restoration, editor resizing, and existing edit/report workflows.
  - Refresh the affected original cards after success and allow the regular page loading rules to determine whether the new reply belongs in the current filtered feed.
- [ ] Add focused safeguards and issue #3612 regressions, following `CODE_REVIEW.md` and the test-scope skill.
  - Database-backed tests: atomic multi-citation creation/rollback; duplicate/replayed ingestion; both relationship lookup directions; nullable foreign-key survival; deletion of either endpoint setting the relationship flag; soft-deleted originals/replies returned as tombstones without preview data; chronological chains; late original resolution; and canonical duplicate mapping.
  - Authorization tests: a viewer can reply to a readable source, cannot cite an inaccessible source or choose an unauthorized group, and cannot obtain deleted/inaccessible preview content or bypass ordinary create/edit permissions.
  - Extend existing Duty/Analysis refresh regressions for late relationship arrival, missed-event recovery, burst invalidations respecting scheduling, zero/removed relationships, stale in-flight results, cached preview edits, and preserved scroll/unread behavior. Keep the #3546 creation-time regressions in CI.
  - Cover deterministic group fallback and exhaustion, error logging, and prevention of duplicate replies under the agreed rejection/retry rules.
  - Add browser coverage under `wdintel-web/tests/e2e/` for reply action → standard editor with one citation → submission → original/chain display → confirmed navigation on both routes. Seed multi-citation relationships to verify rendering separately from the deferred selection UI; cover deleted warnings, unavailable endpoints, keyboard focus, and delayed card-height changes. Preserve `@regression` title tags.
  - Cover both timestamps in the response and frontend time-basis selection: Duty remains on creation time, while changing the Analysis setting updates citations without another reply fetch.
  - Put React specs directly in the nearest production-owned `__tests__` directory. Avoid snapshots, trivial formatter tests, or mocked call-order tests without an observable failure boundary.
- [ ] Complete implementation validation and documentation.
  - Run narrow formatting, `cargo fmt --check`, `cargo check`, `cargo clippy`, focused database-backed tests, and the relevant retained backend suite. After TS/TSX/CSS/JSON edits run `cd wdintel-web && npm run format:staged` without unrelated formatter changes.
  - After migrations, use `source deploy/setup_test_database.sh <branch-safe-name>`, `TEST_DB_NAME="$DB_NAME" just migrate-up`, and `GITHUB_BASE_REF=<actual-base-branch> TEST_DB_NAME="$DB_NAME" scripts/ci/check_analytics_migration_catalog.sh`. Determine the actual base without changing it; do not use the script's `HEAD^` default. Configure entity generation against the migrated local database.
  - Run `just gen-front`, relevant frontend regressions, `npm run test:ts`, and `just build-front`; compile any manually changed Elm files with `elm make ... --output=/dev/null`. Execute affected Playwright suites against the local test environment; discovery alone is insufficient.
  - Capture representative `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)` evidence for batched reply reads and pending-reference reconciliation, including high reply counts, per `QUERY_PERF.md`.
  - Update the focused reply contract and relevant Duty polling/time documentation together with executable acceptance coverage; record complete repository-relative test paths in behavior contracts. Leave `README.md` and `docs/README.md` unchanged unless the system architecture or essential setup actually changes.
  - Add a concise Ukrainian `CHANGELOG.md` `NEXT` entry beginning with `[#3612](https://github.com/echoua/echo/issues/3612)` using the changelog skill; mark any genuinely required manual deployment actions with 👷.
  - Any later staging/production operation requires separate explicit approval naming the target and commands after local preparation and validation are complete. Planning does not authorize deployment, remote migrations, or analytics repair.

## QnA

No unresolved questions.
