# Message unit selection

Message creation, editing, and report creation accept the optional `unit_id`
and `create_unit` fields (#3535). An explicit ID selects an existing,
non-deleted unit; `create_unit: true` requires a nonempty name and no ID.
Message writers (`Rer` or `Cyber`, including administrators) can add name-only
units through this flow; general unit editing still requires `UnitsEditor`.
Creation reuses a unique name match, rejects ambiguous names, and serializes
concurrent inline creation by normalized name. Name matching collapses
whitespace and ignores case. Legacy free-text submissions remain accepted.

Unit activation, parent activity reconciliation, creation audit entries, and
message persistence share the same database transaction. Existing units are
locked until commit, so concurrent deletion cannot invalidate a selection.

Explicit selection is stored in `sigint_inbox_item_unit_selection`, together
with the source unit text and a hash of the stored message body. The normal
resolver honors it during failed-label
retries, unit reprocessing, full message reprocessing, and cached backfills.
Full reprocessing restores the selected unit metadata when the body is unchanged.
Ordinary editor saves preserve the ID without reactivating archived units when
the unit is unchanged, and refresh the body snapshot. Changing source text or
explicit unit metadata clears the selection and resumes ordinary resolution;
deleting a unit makes its selection ineligible. Unit merges transfer selections
to the surviving ID. Message copies retain the selected ID.

The selection table is excluded from analytics replication: analytical queries
consume the reconciled `sigint_inbox_item_unit` links. Deployment applies the
ordinary migrations after synchronizing the packaged analytics exclusions.
Roll back the application before dropping this migration. Dropping the table
removes explicit selections; the previous application resolves message text.

`POST /api/sigint/unit/search` retains the active-only default and supports
`include_inactive: true` and exact-name `names` lookup. Ordinary searches return
at most 50 units; searches including inactive units return at most 250. Nonempty
searches order candidates by echelon from highest to lowest before applying the
limit, then by name and ID, with exact-name matches first within their echelon
when inactive units are included. Empty searches fetch the first 50 units by
name and ID. Returned options follow echelon order; units without hierarchy
follow classified units.
Narrow the search to find further children. Exact-name lookup
uses the existing normalized-name index.

The editor validates saved history, removes unresolved names only after a
successful lookup, and prefills only an unambiguous first recent name. Recent
choices follow the same echelon ordering in the dropdown.
Identically named options show their unit IDs. Late
responses cannot overwrite manual input. A search failure remains visible and
withholds the creation option until a successful retry. Pasted-text parsing
can replace a recent-unit default because prefilling is not a manual edit.

Creation forms automatically select a unique exact unit name after a successful
search, including names supplied by the parser. Partial matches and duplicate
names require an explicit choice. The inline creation option appears only when
the current search succeeds without any candidates. Choosing it opens the shared
unit form from `/rer-units-neo` with the typed text in `name`. Message writers can
create full units without requiring `UnitsEditor`; merging existing duplicates
still requires `UnitsEditor`. Saving this form immediately
creates the unit and selects its ID in the message; cancelling leaves the text
unresolved. Cancelling the message afterwards does not remove the saved unit.
`POST /api/sigint/unit/create-for-message` accepts the full unit and optional
network fields using `CreateUnitWithAutoNetworkReq` and returns a `Unit`.
It shares the direct-submit normalized-name lock, reuses a unique non-deleted
exact match without changing its fields or networks, and rejects ambiguous
matches before inserting. Newly created units and their optional network are
saved in one transaction. Retrying a network-enabled creation after a post-commit
failure replays network-change notifications, inbox invalidation, and unit-tag
recalculation for the reused unit's active networks without creating duplicates.
Both unit creation entry points skip the network step when `hide_networks` is
enabled, even when the devices section is enabled. Nonempty unresolved unit text displays
`Підрозділ не обрано` and blocks creation, including keyboard submission.
Whitespace-only unit text remains optional. Existing editors continue accepting
legacy labels. Network assignments retain all verified unit IDs and the locked
display; incomplete or failed unit lookups keep the field locked, block creation,
and can be retried. Clearing a network preserves a verified single-unit selection;
creation forms clear an unresolved or multiple-unit label so a standalone unit can
be selected. Repeated creation retains the network signal type along with its name
and unit assignment.

Copied source-network lookups support retry and cannot overwrite a later manual
network or unit choice, persisted unit selection, or report edits. Automatic exact
unit matches do not cancel source-network hydration or its retries.
Automatic exact-name resolution preserves the initial unit identity used by
unsaved-change detection and remains automatic for parser ownership and
pristine-source clearing. Explicitly accepting a conflicting parsed unit releases
the network-owned unit assignment while retaining the network name.

Regression coverage lives in `wdintel-rs/src/sigint/direct_submit/units.rs`,
`wdintel-rs/src/sigint/unit/message_creation.rs`, and
`wdintel-web/tests/e2e/manage-message-unit.regression.spec.ts`; parser ownership
is covered by
`wdintel-web/src/ts/react/routes/shared/manage-message/__tests__/ManageMessageDrawer.edit.spec.tsx`.
