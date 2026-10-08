# RER report administration

`/admin/all-reports?tab=rer-report` contains the system switch, access-list editor,
and unit metadata table. All six `/api/admin/rer-report/*` endpoints require an
administrator. The existing system switch endpoint remains unchanged.

The access list controls only the Analysis Neo `для звіту РЕР` checkbox. Both the
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

Each SIGINT unit has at most one metadata row. `locations` and `labels` contain
strings, trimmed and deduplicated case-sensitively in insertion order. Empty
entries are rejected; at least one list must contain a value. Selecting a unit
for a new row seeds its name as a label; changing that selection updates the
seeded label while preserving custom labels. Creation and reassignment require
an active, non-deleted unit without another metadata row.
Existing rows remain editable when their unchanged unit becomes inactive or
soft-deleted.

Synchronous and staged unit merges move a lone source row to the survivor or
union both lists with survivor values first. Remaining-reference checks include
metadata. Metadata writes share unit-merge advisory locks, and mutations commit
with their response data. If a merge moves a row while a mutation waits for its
lock, the mutation fails and the administrator must reload before retrying.

Each successful admin-page load is retained when another section fails. Failed
sections remain disabled and show an error with retry; unloaded defaults cannot
be saved. Retry fetches only failed sections and preserves unsaved access-list
changes. The table uses the shared MRT state provider: filters and sorting use
URL parameters, while column layout uses the `admin-rer-report-metadata` local
storage key. Tab changes preserve the table's URL parameters.

## Deployment and recovery

`m20261008_080110_rer_report_admin` creates `rer_report_access_login` and
`sigint_unit_rer_report_metadata`. Both are PostgreSQL-only configuration tables,
excluded in `deploy/clickhouse/env/tables-exclude.txt` with matching `excluded`
analytics impact declarations. Normal deployment synchronizes these exclusions
before applying migrations; no mirror resync or historical backfill is needed.
The new access list is initially empty. Enable the system switch and save the
intended users in the admin tab to expose the Analysis checkbox.

Reload after a failed/stale metadata operation before editing again. A failed
write rolls back; retrying must use the reloaded row/unit. Downgrading this
migration drops both configuration tables, so export their contents before a
rollback if they must be preserved.

## Regression coverage

- `wdintel-rs/src/rer_report_admin/tests.rs`: exact membership, serialized list
  replacement and rollback, metadata CRUD conflicts, real synchronous merge,
  and metadata writes waiting for concurrent merges.
- `wdintel-rs/src/sigint/unit/merge_task.rs`: staged metadata transfer.
- `wdintel-web/src/ts/react/__tests__/admin-all-reports-element.spec.tsx`:
  snackbar context on the direct RER tab.
- `wdintel-web/src/ts/react/routes/admin-all-reports/__tests__/index.spec.tsx`:
  persisted settings under partial failures, retry, unavailable account removal,
  saved switch, and shared URL parameters.
- `wdintel-web/src/ts/react/routes/admin-all-reports/__tests__/RerReportMetadataEditor.spec.tsx`:
  selected-unit text and seeded-label reconciliation.
- `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx`:
  eligibility and hidden-filter cleanup.
- `wdintel-web/tests/e2e/analysis-neo.spec.ts`: Analysis browser flows.
- `wdintel-web/tests/e2e/rer-report-admin.spec.ts`: real admin tab partial-failure
  recovery and metadata dialog on phone and desktop widths.
