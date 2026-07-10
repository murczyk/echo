# Organism Invites To Secret Groups

## Open Items

- [x] Review `origin/1258-organism-invites-mk2` against current `2808-private-organism-groups`.
- [x] Review current secret-group access, organism, user, admin-directions, and settings-my-groups code paths.
- [ ] Add a new current-dated pure SQL migration for organism-based secret-group invites.
  - Create `secret_group_organism` with `id bigserial primary key`, `master_key text not null references signal_group(master_key) on update cascade on delete cascade`, `organism_id bigint not null references organism(id) on delete cascade`, `created_at timestamp without time zone not null default (now() at time zone 'utc')`.
  - Add `secret_group_organism_id bigint references secret_group_organism(id) on delete cascade` to `secret_group_user`.
  - Add unique indexes for `(master_key, organism_id)` on `secret_group_organism` and `(master_key, login, coalesce(secret_group_organism_id, 0))` or equivalent duplicate prevention on `secret_group_user`.
  - Register the migration in `echo-migration/src/lib.rs`; run `just migrate-up` and `just gen-seaorm`.
- [ ] Update generated SeaORM entities after migration.
  - Expect a new `secret_group_organism` entity and relation entries in `organism`, `signal_group`, `secret_group_user`, `entities/mod.rs`, and `entities/prelude.rs`.
- [ ] Rebuild the old branch behavior in current `wdintel-rs/src/sigint/zone/bl.rs`, not by cherry-picking.
  - Extend `ZoneDatasourceGroup`, `ZoneDatasourceGroupAddReq`, `ZoneDatasourceGroupUpdateReq`, `MyAdminSignalGroup`, and `MyAdminSignalGroupUpdateReq` with `allowed_organism_ids` / `organism_ids`.
  - Split direct secret users from organism-derived users by `secret_group_organism_id is null`.
  - Extend `update_signal_group_access_and_admins` to replace direct users, invited organisms, derived users, and admins in one transaction.
  - If `is_secret` is false, clear both `secret_group_user` and `secret_group_organism`.
  - Return selected organism ids using `secret_group_organism.organism_id`; avoid the old branch bug that returned the invite row id.
- [ ] Add a small membership refresh helper.
  - Recompute derived `secret_group_user` rows from `secret_group_organism` and active, non-permanently-deleted logins.
  - Remove derived rows for disabled/deleted organisms and deleted/permanently-deleted/moved logins.
  - Compare `login.organism_id` to `secret_group_organism.organism_id`; avoid the old branch bug that compared organism id to invite row id.
- [ ] Call the refresh helper from current mutation points that can change derived membership.
  - `users::update_login`, `users::delete_login`, `users::create_login`, `users::register_user`, and `register_delta_user`.
  - `organism::update_organism` and `organism::delete_organism`.
  - Keep all refresh calls inside the same transaction as the mutation.
- [ ] Preserve existing access semantics.
  - `filter_out_ineligible_secret_chats` can continue to use `secret_group_user`; organism invites should materialize into that table so all existing report/inbox paths keep working.
  - Current organism group availability and AOR filtering stay separate from secret-chat membership.
- [ ] Update admin frontend API wrappers in `wdintel-web/src/ts/react/services/api/zones.ts`.
  - Normalize `allowedOrganismIds` / `allowed_organism_ids`.
  - Send `organism_ids` on zone datasource group add/update and my-admin group update requests.
- [ ] Update admin directions UI.
  - Load organism options via the existing organisms API.
  - Add organism multi-selects to hidden-group edit and orphan assignment dialogs.
  - Show invited organism names in the access column together with direct users.
- [ ] Update settings my-groups UI if group admins should manage organism invites.
  - Add selected organism state, reference data, table display, and save payload handling.
  - Restrict selectable organisms according to the decision in `QnA`.
- [ ] Regenerate frontend bindings with `just gen-front`.
- [ ] Add backend tests.
  - Updating a secret group with organism ids creates `secret_group_organism` rows and derived `secret_group_user` rows.
  - Direct users remain direct and are not removed when overlapping with organism-derived users.
  - Moving/deleting/deactivating a login refreshes derived membership.
  - Disabling/deleting an organism removes its derived secret access.
  - `bl_szd_groups_list` and `my_admin_groups` return organism ids, not invite ids.
- [ ] Add focused frontend tests for API normalization and the UI surfaces touched.
- [ ] Run verification.
  - `cargo fmt`
  - `cargo check`
  - Targeted `cargo test -p wdintel-rs ...` for zone/user/organism secret membership tests
  - `cd wdintel-web && npm run format:staged`
  - `just gen-front` if bindings changed
  - `just build-front`

## QnA

- [ ] Should organism invitations include child organisms recursively?
  - answer: no; invite exactly the selected organism. This matches the old branch and avoids surprising access expansion.
- [ ] Should non-admin group admins in Settings -> My Groups be allowed to invite whole organisms?
  - answer: yes, but only their own organism initially. Global Admins can invite any active organism from Admin Directions.
- [ ] Should derived rows be materialized in `secret_group_user` or should access checks join `secret_group_organism` live?
  - answer: materialize derived rows, because current access checks and report paths already depend on `secret_group_user` and the old branch used the same compatibility approach.
