# Handoff: echo-pivnich duplicate BBC NEWS filters

## Context

User reported `BBC News` shown twice in group filters on:

- `/rer-analysis`
- `/rer-analysis-neo`
- `/rer-duty-neo`

Important domain rule from user: one logical group can be shared by messenger datasources and `echo_operator` integration datasources. That is expected. The expected representation is multiple `datasource_group` rows pointing at the same canonical `signal_group.master_key`.

## Prod Evidence Collected

Read-only queries were run on `echo-pivnich` against DB `wd`.

Current live `signal_group` rows named `BBC NEWS`:

- `120363419907122319@g.us`
  - canonical WhatsApp/messenger group
  - `signal_group.datasource_id = 22`
  - `datasource_group` rows for 7 WhatsApp datasources: ids `{178,702,777,787,805,942,970}`
  - linked messages: about `2,654,458`
  - recent last message: `2026-09-05 12:41:41 UTC`
- `echo.019ebab3-d6e8-7ff6-b662-004ee7394520`
  - bad fallback `echo_operator` group for datasource id `37`
  - datasource display name: `EХО Оператор echo-operator-151-5`
  - datasource_group id `1028`
  - linked messages: about `46,725`
  - recent last message: `2026-09-05 12:41:36 UTC`
- `echo.019ebabb-6ba9-70b8-a752-eb63c6872efa`
  - bad fallback `echo_operator` group for datasource id `38`
  - datasource display name: `EХО Оператор echo-operator-151-4`
  - datasource_group id `1031`
  - linked messages: about `6,678`
  - last message: `2026-07-30 10:16:04 UTC`

Recent two-day active groups for `BBC NEWS`:

- `120363419907122319@g.us`: `20694` messages
- `echo.019ebab3-d6e8-7ff6-b662-004ee7394520`: `2558` messages

This explains why duty currently shows two entries: duty loads recent active group master keys, and those two master keys both have recent messages with the same visible name.

## Relevant Code Paths

- Backend group facet for analysis: [wdintel-rs/src/rer_importer/analysis/stats.rs](/home/andrii/.workspace/echo-copy/wdintel-rs/src/rer_importer/analysis/stats.rs)
  - `build_groups_query` groups by `signal_message_group.group_master_key`.
- Backend group names: [wdintel-rs/src/rer_importer/analysis/mod.rs](/home/andrii/.workspace/echo-copy/wdintel-rs/src/rer_importer/analysis/mod.rs)
  - `collect_group_names` returns one `SignalGroupEntry` per master key.
- Classic `/rer-analysis`: [wdintel-web/src/Pages/RerAnalysis.elm](/home/andrii/.workspace/echo-copy/wdintel-web/src/Pages/RerAnalysis.elm)
  - `GotStatsGroups` fills `groupInfos` by master key and builds one menu item per `rsp.groups` entry.
- Neo `/rer-analysis-neo`: [wdintel-web/src/ts/react/routes/rer-analysis-neo/components/analysis-filters-panel-derived.ts](/home/andrii/.workspace/echo-copy/wdintel-web/src/ts/react/routes/rer-analysis-neo/components/analysis-filters-panel-derived.ts)
  - `buildMergedGroupOptions` already merges options by displayed label.
- `/rer-duty-neo`: [wdintel-web/src/ts/react/routes/rer-duty-neo/useFeedFilterPanelViewModel.ts](/home/andrii/.workspace/echo-copy/wdintel-web/src/ts/react/routes/rer-duty-neo/useFeedFilterPanelViewModel.ts)
  - options are sorted master keys and labels come from `groupInfos[key]?.name`.
  - duplicate visible names are intentionally not merged there today.
- `echo_operator` group resolver: [wdintel-rs/src/operator/mod.rs](/home/andrii/.workspace/echo-copy/wdintel-rs/src/operator/mod.rs)
  - `ensure_group` resolves source/canonical group keys.

## Suspected Bug

`ensure_group` had two prevention holes:

1. It used:
   ```rust
   group.source_signal_group_id.or(group.source_whatsapp_group_jid)
   ```
   This treats `Some("")` or whitespace as a real source key, so an empty Signal source value can suppress a valid WhatsApp source key.

2. If an `echo_operator` datasource already had a fallback `echo.*` `datasource_group` row and a later payload included a valid source messenger key, `ensure_group` still preferred the existing `echo.*` datasource group. That prevents convergence back to the canonical messenger `signal_group.master_key`.

Production shape matches this: operator fallback rows were created on `2026-06-12`; one is still receiving current messages under `echo.*` instead of the WhatsApp master key.

## Done In Working Tree

Only file changed:

- [wdintel-rs/src/operator/mod.rs](/home/andrii/.workspace/echo-copy/wdintel-rs/src/operator/mod.rs)

Changes made:

- Added `source_group_key` and `non_empty_source_key`.
  - trims source IDs
  - ignores blank `source_signal_group_id`
  - falls back to nonblank `source_whatsapp_group_jid`
- Added `move_datasource_group_to_source_group`.
  - when source key is present and only an existing `echo.*` datasource group is found, retarget that datasource group to the source/canonical master key
  - refreshes name, deleted flag, and `last_sync_at`
- Added `ensure_source_signal_group`.
  - reuses existing source `signal_group`
  - creates source `signal_group` only if the source key is not already present
- Added tests:
  - `source_group_key_ignores_blank_values`
  - `ensure_group_moves_existing_echo_mapping_to_source_group`

`cargo fmt` was run.

No commit was made.

## Validation Status

Attempted:

```bash
cargo test -p wdintel-rs operator::tests
```

The first attempt was started after a wrong Cargo invocation. It was still compiling dependencies when the user requested handoff, so the local `cargo test` process was stopped. No pass/fail result yet.

Still required:

```bash
cargo test -p wdintel-rs operator::tests
cargo check
cargo clippy
```

Depending on time, a narrower check can start with:

```bash
cargo test -p wdintel-rs source_group_key_ignores_blank_values
cargo test -p wdintel-rs ensure_group_moves_existing_echo_mapping_to_source_group
```

## Pending Work

1. Review the patch in [wdintel-rs/src/operator/mod.rs](/home/andrii/.workspace/echo-copy/wdintel-rs/src/operator/mod.rs) for compile errors and behavior.

2. Run validation:
   ```bash
   cargo test -p wdintel-rs operator::tests
   cargo check
   cargo clippy
   ```

3. If validation passes, deploy the code to `echo-pivnich`.

4. Before modifying prod data, dry-run the existing oneoff:
   ```bash
   ssh echo-pivnich 'sudo /usr/bin/wdintel-rs --mode=live oneoff-merge-datasource-group --target-group-key 120363419907122319@g.us --dry-run'
   ```

   Expected dry-run output should include merging:
   - `echo.019ebab3-d6e8-7ff6-b662-004ee7394520` into `120363419907122319@g.us`
   - `echo.019ebabb-6ba9-70b8-a752-eb63c6872efa` into `120363419907122319@g.us`

5. If dry-run output is correct, run the oneoff for real:
   ```bash
   ssh echo-pivnich 'sudo /usr/bin/wdintel-rs --mode=live oneoff-merge-datasource-group --target-group-key 120363419907122319@g.us'
   ```

6. Verify prod after oneoff:
   ```sql
   select sg.master_key, sg.name, sg.deleted, sg.is_archived, d.kind, d.display_name, dg.id, dg.group_master_key
   from signal_group sg
   left join datasource_group dg on dg.group_master_key = sg.master_key
   left join datasource d on d.id = dg.datasource_id
   where lower(sg.name) = lower('BBC News')
   order by sg.master_key, dg.id;
   ```

   Expected:
   - only canonical `120363419907122319@g.us` remains live for `BBC NEWS`
   - operator datasource groups `1028` and `1031` point to `120363419907122319@g.us`
   - old `echo.*` `signal_group` rows are soft-deleted

7. Verify UI filters on `/rer-analysis`, `/rer-analysis-neo`, and `/rer-duty-neo`.

## Notes

- The existing oneoff is in [wdintel-rs/src/operator/oneoff.rs](/home/andrii/.workspace/echo-copy/wdintel-rs/src/operator/oneoff.rs).
- The oneoff is intended for old bad data. The code patch above is intended to prevent recurrence and to allow runtime convergence if a source key appears after a fallback mapping already exists.
- `rer-analysis-neo` already merges duplicate visible group labels client-side, but it still receives distinct master keys from the backend. The data should still be repaired so all pages and backend facets agree on one logical group key.
