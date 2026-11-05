# RER report administration

`/admin/system-settings-neo#reports` contains a standalone RER block with the
system switch, access-list editor, and unit metadata table. All six `/api/admin/rer-report/*` endpoints require an
administrator. The existing system switch endpoint remains unchanged.

The access list controls only the Analysis Neo `Для звіту РЕР` checkbox. Both the
global `rer_report_enabled` setting and explicit current-login membership are
required, including for administrators. Report templates and generation retain
the existing system-switch gate. When access is denied, Analysis clears the
hidden `onlyWithNetwork` filter from requests and the URL.
Failed access checks preserve a requested filter and defer message loading,
including direct-message links, until access can be determined.

The selector offers active human accounts, including Delta-authenticated users,
and excludes API/service accounts. Previously selected inactive or unavailable
accounts remain visible and removable. Replacing the access list is transactional
and serialized; an invalid login leaves the saved list intact.

Each SIGINT unit has at most one metadata row. `report_name` is a required,
trimmed, single-line «Назва для звіту»; optional `locations` are shown as
«Райони розташування», trimmed and deduplicated case-sensitively. New names
are seeded from the selected unit without replacing manual edits. Creation
and reassignment require an active, non-deleted unit; existing inactive or
deleted rows stay editable and are visibly marked.

Configuration includes every descendant across all 14 echelon fields, with
regional context and hierarchy gaps preserved. Different unit IDs at an identical
complete path are peers, not descendants, and need separate configuration.
A closer explicit row overrides
an ancestor. Inactive units remain eligible; deleted units do not. Units with
no hierarchy match themselves only. Identical, case-sensitive report names
combine into one section, unioning locations from contributing rows. Names
shared across contradictory known reporting-parent contexts are rejected in the editor
and backend; the existing parent headings remain in the DOCX. Missing hierarchy
is allowed: units sharing a name use its known parent, or the report name when
all of them lack hierarchy.

Reports and the Analysis checkbox match catalog unit associations (`Parsed`
and existing `Network` links), regardless of group kind. RER generation retains
all current Analysis filters and the existing comment, blacklist, «інше», time,
and duplicate rules. If different names match one message, an error is logged
and one candidate at the highest echelon is chosen randomly. The message
appears once. Nonempty configuration and eligible messages are required.

The server captures configuration and expanded hierarchy when enqueueing a
report. That snapshot is retained through retries and participates in duplicate
request detection. Execution still rechecks access and excludes deleted units.
The `only_for_rer_report` API flag filters both Analysis messages and statistics;
these queries use PostgreSQL because metadata is excluded from analytics.
Analysis Neo retains the legacy `onlyWithNetwork` UI/URL property and maps it
to the new flag. The generic `only_with_network` API filter is unchanged.

Synchronous and staged unit merges move a lone source row to the survivor,
otherwise keep the survivor's report name and union locations with survivor
values first. Remaining-reference checks include metadata. Metadata writes
share unit-merge advisory locks and serialize report-name validation. A stale
mutation fails after a concurrent merge and requires a reload before retry.

Non-RER groups no longer create new inbox-to-network mappings, including
through message copies and recalculation when the support switch is disabled.
Historical mappings and their unit associations are retained unchanged; there
is no cleanup or historical unit backfill. New unresolved unit associations
are left to the existing resolution workflow.

Each successful admin-page load is retained when another section fails. Failed
sections remain disabled and show an error with retry; unloaded defaults cannot
be saved. Retry fetches only failed sections and preserves unsaved access-list
changes. The table uses the shared MRT state provider: filters and sorting use
URL parameters, while column layout uses the `admin-rer-report-metadata` local
storage key. The scalar report-name column retains the legacy `labels` table
column ID so existing filters, sorting, widths, and layout remain valid. Tab
changes preserve the table's URL parameters.

## Deployment and recovery

`m20261008_080110_rer_report_admin` creates `rer_report_access_login` and
`sigint_unit_rer_report_metadata`. Both are PostgreSQL-only configuration tables,
excluded in `deploy/clickhouse/env/tables-exclude.txt` with matching `excluded`
analytics impact declarations. Normal deployment synchronizes these exclusions
before applying migrations; no mirror resync or historical backfill is needed.
The new access list is initially empty. Enable the system switch and save the
intended users in the admin tab to expose the Analysis checkbox.

`m20261104_165252_rer_report_unit_selection` adds nullable `report_name` to the
excluded metadata table. It keeps the first old label, discards additional
labels, and uses the catalog unit name for empty lists. The legacy `labels`
column remains synchronized for compatibility. Review report names and shared
parent contexts after migration. No analytical resnapshot, link cleanup, or
historical unit repair is needed. Deploy compatible application and report
workers together after explicit environment approval; old workers may still
create the obsolete non-RER mappings. Export configuration before reverting
schema changes, since discarded labels cannot be recovered by application
rollback. Dropping only the new column preserves the first legacy label.

Reload after a failed/stale metadata operation before editing again. A failed
write rolls back; retrying must use the reloaded row/unit. Downgrading the original
`m20261008_080110_rer_report_admin` migration drops both configuration tables,
so export their contents before a rollback if they must be preserved.

## Regression coverage

- `wdintel-rs/src/rer_report_admin/scope_tests.rs`: full hierarchy expansion, overrides, configuration changes, region conflicts, and message membership.
- `wdintel-rs/src/rer_importer/reports/rer.rs`: #3940 configuration-based report grouping and filter preservation.
- `wdintel-rs/src/sigint/unit_tag/mod.rs`: #3940 future-only non-RER network assignment.
- `wdintel-rs/src/sigint/direct_submit/query.rs`: #3940 non-RER copies preserve direct unit associations without copying network mappings.

- `wdintel-rs/src/rer_report_admin/tests.rs`: exact membership, serialized list
  replacement and rollback, metadata CRUD conflicts, real synchronous merge,
  and metadata writes waiting for concurrent merges.
- `wdintel-rs/src/sigint/unit/merge_task.rs`: staged metadata transfer.
- `wdintel-web/src/ts/react/__tests__/system-settings-neo-element.spec.tsx`:
  snackbar context on the direct Reports settings tab.
- `wdintel-web/src/ts/react/routes/admin-system-settings-neo/__tests__/RerReportSettings.spec.tsx`:
  persisted settings under partial failures, retry, unavailable account removal,
  and saved switch.
- `wdintel-web/src/ts/react/routes/admin-system-settings-neo/__tests__/RerReportMetadataEditor.spec.tsx`:
  selected-unit text and scalar-name seeding/customization.
- `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx`:
  eligibility and hidden-filter cleanup.
- `wdintel-web/tests/e2e/analysis-neo.spec.ts`: Analysis browser flows.
- `wdintel-web/tests/e2e/rer-report-admin.spec.ts`: Reports settings partial-failure
  recovery and metadata dialog on phone and desktop widths.
