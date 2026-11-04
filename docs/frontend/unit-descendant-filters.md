# Descendant unit filters

Analysis and Duty keep the user's unit selection separate from the concrete
unit IDs sent to inbox, count, map, report, and reconciliation requests. A
selection always includes its own catalog rows and descendants within the same
hierarchy path. The catalog includes
inactive units. Region and military-district groups are not added as parent
options; parents start at army level. Hierarchy path separators are escaped
so unit names cannot merge unrelated paths.

A parent without its own catalog row has a synthetic selection value and
matches its descendants. An unresolved selection must never become an
unrestricted query or the undefined-unit filter. Missing catalogs block only
requests that need expansion. Catalog failures are visible and retried, and
browser focus/online recovery reloads the catalog and invalidates affected
requests. Duty's other feeds can continue loading.

Parent counts add the counts of their own rows and descendants. Leaf counts
use distinct message IDs, including when a message has multiple link kinds.
A message linked to two different descendant units contributes to both units'
counts; the parent shows their sum. Both pages load the hierarchy automatically
and aggregate parent counts locally, without a checkbox or hierarchy progress
bar. Duty fetches leaf counts automatically and coalesces inbox-change refreshes.
Its unit facet preserves other include/exclude filters while omitting unit filters.
Analytics history and the PostgreSQL recent tail use disjoint creation-time
ranges, with PostgreSQL fallback if analytics fails.

Saved Analysis filters retain the original selection in optional
`unit_filter` metadata alongside the concrete request snapshot. Older clients
can still use the snapshot. Duty saved filters and short URLs retain
`units_include_children` for compatibility. Older URLs and saved filters with
descendants disabled now include descendants too; the legacy flag does not
affect filtering or mark a saved filter dirty. These values use existing
JSON/short-state storage and require no schema migration.

Inbox reconciliation uses the expanded filters, removes messages whose edited
unit no longer matches, and rejects responses for obsolete scopes. Duty retains
its creation-time ordering and unread-state contract. Analysis direct-message
and reply windows wait for the same hierarchy and never turn an unresolved
request into an unrestricted around-message request.

Regression coverage:

- `wdintel-web/src/ts/react/routes/shared/__tests__/unit-children-filter.regression.spec.ts`
- `wdintel-web/src/ts/react/routes/rer-duty-neo/__tests__/useRerDutyFeeds.spec.ts`
- `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-analysis-data.core.inbox-refresh.spec.tsx`
- `wdintel-web/src/ts/react/routes/rer-analysis-neo/__tests__/use-rer-analysis-neo-page.spec.tsx`
- `wdintel-web/tests/e2e/unit-children-filter.spec.ts`
- `wdintel-rs/src/rer_importer/inbox/mod.rs`
- `wdintel-rs/src/rer_importer/analysis/tests.rs`
- `wdintel-rs/src/server/read_deadline.rs`
