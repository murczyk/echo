# Linked SIGINT unit statistics rollout

## Goal

Use `sigint_inbox_item_unit.unit_id` and `sigint_unit.name` for RER analysis unit statistics and filtering without requiring an in-place conversion of legacy unit-text statistics.

## Pull request 1: populate linked-unit statistics

- [x] Resolve the open questions below before changing the aggregate schema.
- [x] Define a new unit aggregate keyed by `sigint_unit.id`; keep the existing `unit_v2` aggregate and all current readers unchanged.
- [x] Load linked unit IDs for each statistics message through `sigint_inbox_item_unit`.
- [x] Deduplicate `(message_id, unit_id)` so a message linked to the same unit by multiple link kinds is counted once where applicable.
- [x] Populate linked-unit counts and distinct-message HLLs in 5-minute statistics.
- [x] Aggregate the new linked-unit values into daily statistics.
- [x] Write the new aggregate alongside the legacy unit-text aggregate in regular worker recalculations.
- [x] Write the new aggregate from `oneoff-calculate-stats` and `oneoff-calculate-historic-stats`.
- [x] Keep `/rer-analysis` unit statistics, counters, and filters on the legacy path in this PR.
- [x] Add focused tests for multiple linked units, duplicate parsed/network links, missing links, 5-minute aggregation, and daily aggregation.
- [x] Run `cargo fmt`.
- [x] Run focused statistics tests.
- [x] Run `cargo check` and `cargo clippy`.
- [x] Review `git status` and `git diff`; do not commit or push without permission.

## Deployment between pull requests

- [ ] Merge and deploy pull request 1.
- [ ] Recalculate the required 5-minute and daily history for the past year:

  ```bash
  stats_start="$(TZ=Europe/Kyiv date -d '1 year ago' '+%Y-%m-%dT00:00:00')" && sudo /usr/bin/wdintel-rs --mode=live oneoff-calculate-historic-stats --start "$stats_start"
  ```
- [ ] Verify the new aggregate covers the intended date range and signal-group batches.
- [ ] Compare linked-unit counts against direct PostgreSQL queries for representative periods, including messages with multiple unit links.
- [ ] Confirm regular workers continue populating new buckets after the historical recalculation completes.
- [ ] Confirm `sigint_inbox_item_unit` and `sigint_unit` are available through the analytics read path before pull request 2.

## Pull request 2: switch readers and filters

- [ ] Read unit filter counters from the new unit-ID aggregate.
- [ ] Resolve aggregate unit IDs to current, non-deleted `sigint_unit.name` values.
- [ ] Include the unit ID in the unit-filter API/UI identity so duplicate names remain separate options.
- [ ] Mark non-deleted units with duplicate names as deduplication candidates.
- [ ] Build live/PostgreSQL unit facet statistics through `sigint_inbox_item_unit` joined to `sigint_unit`, counting distinct messages per unit.
- [ ] Update analytics unit facet statistics to use the same linked-unit source.
- [ ] Filter selected and denied units by `sigint_unit.name` through `sigint_inbox_item_unit` instead of `sigint_inbox_item.unit_v2` and inferred network joins.
- [ ] Preserve the agreed `units_exact_match_only` behavior using `sigint_inbox_item_unit.kind`, or remove the option if it is intentionally obsolete.
- [ ] Treat a message as `Не визначено` only when it has no qualifying linked unit.
- [ ] Update unit counts and exact/non-exact breakdown counters to use linked units.
- [ ] Update reports or other shared callers of the RER unit filter helper, if they must adopt the new semantics.
- [ ] Stop writing and reading legacy `unit_v2` unit statistics.
- [ ] Remove or retire legacy aggregate storage after the cutover is verified; do not add an in-place data migration.
- [ ] Add focused functional tests covering facet values, selected/denied filters, undefined units, link kinds, duplicate links, and multi-unit messages.
- [ ] Run `cargo fmt`.
- [ ] Run focused analysis and statistics tests.
- [ ] Run `cargo check` and `cargo clippy`.
- [ ] Review `git status` and `git diff`; do not commit or push without permission.


## Open questions

- [x] Is the new aggregate a separate Redis bucket/key keyed by unit ID, or is a new PostgreSQL statistics table intended? Current group-statistics persistence is Redis-based.

a: it's a new Redis bucket

- [x] Should statistics include both `parsed` and `network` links, or only `parsed` links?

a: both

- [x] If both link kinds are included, should one message linked to the same unit by both kinds count once? The proposed behavior is once.

a: no, count it exactly once no matter if it's one of kinds or more.

- [x] Should `units_exact_match_only = true` mean `kind = 'network'`, while `false` means both `parsed` and `network`, preserving the current UI meaning of “exact match by etalonka”?

a: yes.


- [x] Should inactive `sigint_unit` rows be included? The proposed behavior is to exclude deleted rows but preserve currently linked inactive rows unless product behavior requires active-only.

a: yes it should be included. it's a great hint actually, that some unit should be activated in admin panel. 


- [x] If a unit is renamed between statistics calculation and display, should historical counters show the current name (ID-keyed aggregate) or the name at calculation time?

a: current name. we expect that renames are fixing bugs in naming as the only valida case for renaming.

- [x] When several active units have the same name, should filtering match all of their IDs and merge their counters into one displayed name?

a: no, don't merge. we want to see such matches as duplicate candidates, and solve them in admin panel, we already have capabilities for that. so if we calculate and notice that - we should ensure duplicates marked as duplicate candidates.

- [x] Which historical date range must be rebuilt between the pull requests, and may deployment proceed if some old buckets have expired before rebuilding?

a: past year. please document a oneoff bash command aht calculates this timestamp and then executes required oneoff in prod (so I could just copy-paste it to prod ssh and re-calculate).

- [x] Which reports outside `/rer-analysis` should switch with the shared unit filtering helpers in pull request 2?

a: all that use unit_v2 and link sigint_inbox_ietm -> sigint_network -> sigint_network_unit -> sigint_unit
