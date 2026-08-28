# Unit ID filters and failed unit label normalization

## Goals

- Make unit filters on `/rer-analysis`, `/rer-analysis-neo`, and `/rer-duty-neo` display `sigint_unit.name` while sending and matching `sigint_unit.id`.
- Use the existing Redis unit-ID statistics for unit facets; keep settlement-ID statistics unchanged.
- Replace `failed_inbox_unit` with a normalized failed-label table and a many-to-many link between failed labels and `sigint_inbox_item`.
- Deliberately discard existing `failed_inbox_unit` rows. The existing oneoff/backfill flow will repopulate the new schema later.

## Behavioral decisions

- Add `selected_unit_ids` and `denied_unit_ids` request fields. New UI interactions must use these fields exclusively.
- Keep the legacy text request fields temporarily for old saved filters and URLs. When loading legacy state, resolve unambiguous names to IDs; unresolved legacy values may continue through the old text fields until they are edited or resaved.
- A selected unit ID matches a message through `sigint_inbox_item_unit`; multiple selected IDs are ORed within the unit facet and combined with other facets using the existing AND semantics.
- A denied unit ID excludes a message if any active canonical link matches it.
- Renaming a unit changes only its displayed label because saved/filter values remain stable IDs. Units with identical names remain separate options because their IDs differ.
- The unit “exact match” control does not apply to ID filters. Hide or disable it when all selected values are IDs, retaining it only for unresolved legacy text filters during the compatibility period.
- `failed_unit_label.is_bad_data` and `failed_unit_label.note` are label-level properties. Retry/deletion state remains per inbox-item/label link.

## 1. Reconcile the current partial implementation

- Review the existing working-tree edits in:
  - `wdintel-rs/src/rer_importer/types.rs`
  - `wdintel-rs/src/rer_importer/analysis/mod.rs`
  - `wdintel-rs/src/rer_importer/inbox/query.rs`
- Keep the request/type additions and ID-backed `EXISTS` filters where they follow the decisions above.
- Complete every request constructor, query path, export, and report path so no endpoint silently ignores the new fields.
- Ensure every propagated Rust error has `.c(h!())?` or `.context(h!())?`.

## 2. Backend unit-ID request and filtering contract

- Extend the generated backend-facing request types used by analysis, inbox, callsign graph, exports, and duty feed/count with nullable ID lists:
  - `selected_unit_ids: Option<Vec<i64>>`
  - `denied_unit_ids: Option<Vec<i64>>` where exclusion is supported
- Update all Rust struct literals, conversions, facet-clearing helpers, and request clones to carry or intentionally clear the fields.
- Apply ID filters with correlated `EXISTS`/`NOT EXISTS` queries against `sigint_inbox_item_unit`, joined to non-deleted `sigint_unit` rows.
- Cover all three pages' data sources, including:
  - inbox rows and counts
  - analysis facet counts
  - callsign graph
  - GeoJSON/KMZ/map data
  - report/export builders
  - duty feed and duty count
- Disable an analytics/ClickHouse shortcut whenever it cannot apply the ID filter correctly, allowing the existing PostgreSQL fallback instead of returning unfiltered results.
- Review the resulting SQL against `QUERY_PERF.md`; verify that the existing link indexes support both item-correlated lookup and unit-ID lookup, and add a migration index only if production-scale `EXPLAIN` evidence shows it is needed.

## 3. Canonical unit statistics

- Change `AnalysisStatsUnit` from text-only output to:
  - `unit_id`
  - `name`
  - `count`
- For database-backed facet queries, join `sigint_inbox_item_unit` to `sigint_unit`, group by unit ID/name, and count distinct inbox items so duplicate links cannot inflate counts.
- When calculating the unit facet itself, clear `selected_unit_ids` from the cloned request just as other self-filters are cleared.
- Use the existing Redis `UnitBucket` ID/HLL data for eligible unfiltered or Redis-supported requests:
  - add the missing daily-unit bucket reader
  - merge five-minute and daily unit HLLs for the requested batches and interval
  - load current names from `sigint_unit` after aggregation
  - omit deleted units
- Do not add another Redis text or ID representation. Preserve the existing settlement-ID buckets and settlement behavior.
- Add focused coverage proving that Redis and PostgreSQL return the same canonical IDs/counts and that a unit rename changes the label without changing the filter value.

## 4. Frontend migration for all three routes

- Regenerate Elm/TypeScript bindings after the Rust contract is complete; do not hand-edit generated bindings.
- `/rer-analysis` (Elm):
  - render `AnalysisStatsUnit.name`
  - store/select `String.fromInt unit_id` as the option value
  - partition persisted values into numeric IDs and legacy text when building requests
  - make top-unit controls and map-originated filters emit IDs
- `/rer-analysis-neo` (React):
  - map unit stats to `{ value: String(unitId), label: name }`
  - keep selection, top values, URL state, saved filters, inbox requests, and map events ID-backed
  - enrich map/popup data with canonical unit IDs where it currently emits only unit text
- `/rer-duty-neo` (React):
  - build include/exclude options from the unit catalog using ID values and name labels
  - send numeric selections through `selectedUnitIds`/`deniedUnitIds`
  - support pasted legacy names by resolving them to catalog IDs before applying the filter
  - preserve unresolved legacy saved values visibly until the user replaces them
- Ensure duplicate unit names have unique option keys and that inactive-but-not-deleted units already present in saved filters remain displayable.
- Keep all existing API error handling/toasts intact.

## 5. Normalize failed unit labels

Create a pure-SQL migration with the current timestamp and register it in `echo-migration/src/lib.rs`.

### `failed_unit_label`

- `id bigserial primary key`
- `created_at timestamp without time zone not null`
- `unit_txt text not null` with the existing nonblank check
- `is_bad_data boolean not null default false`
- `note text not null default ''`
- a unique expression index on `lower(regexp_replace(btrim(unit_txt), '[[:space:]]+', ' ', 'g'))`, guaranteeing one row per normalized failed text

### `sigint_inbox_item_failed_unit_label`

- `id bigserial primary key`
- `created_at timestamp without time zone not null`
- `inbox_item_id bigint not null` referencing `sigint_inbox_item(id)` with `on delete cascade`
- `failed_unit_label_id bigint not null` referencing `failed_unit_label(id)` with `on delete cascade`
- `deleted boolean not null default false`
- `deleted_at timestamp without time zone`
- unique `(inbox_item_id, failed_unit_label_id)` relation
- indexes for active label occurrence counts, inbox-item replacement, and pending retry cleanup/locking

### Migration behavior

- Create both new tables and indexes first, then drop `failed_inbox_unit` without copying rows.
- The down migration recreates the final legacy `failed_inbox_unit` shape and indexes as an empty table, then drops the normalized tables; it cannot restore discarded data.
- Mark the old and both new operational tables as `excluded` in `deploy/clickhouse/migration-impact.json`.
- Replace `public.failed_inbox_unit` with both new tables in `deploy/clickhouse/env/tables-exclude.txt` before deployment applies the migration.
- Update the ClickHouse/storage documentation to describe the exclusion and the intentional rebuild requirement.

## 6. Rewrite failed-unit runtime code

- Regenerate SeaORM entities after applying the migration locally.
- Replace all `failed_inbox_unit` entity references in resolution, unresolved-label administration, tests, and cleanup helpers.
- Failure creation becomes a transaction-safe two-stage upsert:
  1. upsert/find one normalized `failed_unit_label`, preserving label-level archive/note state and applying auto-archive rules
  2. upsert/reactivate the inbox-item/label junction row
- Resolving or reparsing an inbox item updates/deletes only its junction rows; shared label rows remain available for other messages and future oneoff runs.
- The unresolved-label list reads labels joined to active junction rows and derives `quantity` from link count.
- Archive and note endpoints update exactly one label row. Resolve/classify operations mark all active junctions for that label as pending where appropriate.
- The retry worker locks and processes pending junction rows, joins the label text needed for re-resolution, deletes completed/expired junctions, and leaves shared labels intact.
- Update the oneoff/backfill path so recalculation populates the normalized tables through the same upsert functions.
- Audit cascade behavior and concurrent upserts so duplicate labels or duplicate links cannot be created.

## 7. Focused regression coverage

- Unit filters:
  - selected ID includes linked messages and excludes same-name, different-ID units
  - denied ID excludes linked messages
  - multiple selected/denied IDs preserve existing facet semantics
  - deleted units do not appear or match
  - duplicate links do not inflate facet counts
  - all three frontend request builders emit ID fields
  - legacy saved name filters remain loadable during the compatibility period
- Failed labels:
  - case/whitespace variants reuse one `failed_unit_label`
  - one inbox item can link to multiple failed labels and one label can link to multiple inbox items
  - archive/note state is shared at label level
  - resolving a label schedules every active relation without corrupting other labels
  - worker cleanup removes relations but not a label still used elsewhere
  - rerunning the oneoff is idempotent
- Prefer existing database-backed fixtures and frontend request-builder tests; avoid tests that only assert rendered SQL or generated types.

## 8. Generation and validation

Run in this order:

1. `just migrate-up`
2. `just gen-seaorm`
3. `just gen-front`
4. `cargo fmt`
5. `cd wdintel-web && npm run format:staged`
6. targeted Rust database tests and frontend tests for the changed behavior
7. `cargo check`
8. `cargo clippy`
9. `elm make` for each modified Elm page with `--output=/dev/null`
10. `just build-front`
11. restore a dedicated test database from the standard dump with `source deploy/setup_test_database.sh <branch-safe-name>`
12. run `GITHUB_BASE_REF=<base-branch> TEST_DB_NAME="$DB_NAME" scripts/ci/check_analytics_migration_catalog.sh`

Inspect `git status` and `git diff` after generation to ensure only intended source, generated bindings/entities, migration metadata, tests, and documentation changed.

## 9. Deployment and follow-up

- Add a `CHANGELOG.md` `NEXT` entry only after a GitHub issue reference is known, including the intentional loss/rebuild of unresolved-unit data and any required deployment order.
- Deploy the updated ClickHouse exclusions before applying the migration.
- Apply the migration and deploy backend/frontend code together; the old table no longer exists after migration.
- Run the failed-unit oneoff/backfill later to repopulate labels and links, as explicitly accepted for this change.
- Verify analytics health, unit facet counts, include/exclude behavior on all three routes, unresolved-label administration, and retry-worker health before completing rollout.

