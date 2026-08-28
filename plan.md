# Remaining work: `/admin/ai/settlements`

Implementation is present in the working tree but is not committed. The worker is configured disabled by default and appends only missing AI locations to the locked current `location_v2`, preserving all existing values. It also reconciles settlement links in the same transaction.

## Review and corrections

- Review the complete diff against `CODE_REVIEW.md`, especially:
  - `wdintel-rs/src/ai_settlement/mod.rs`
  - `wdintel-rs/src/ai_settlement/worker.rs`
  - `ai-eval/2026-08-28-settlement-prompt/prompt.txt`
  - `echo-migration/src/m20260828_143607_add_ai_settlement_parsing.rs`
  - `wdintel-web/src/ts/react/routes/admin-ai-settlements/`
- Recheck the prompt against additional `echo-kharkiv2` examples, particularly ambiguous header/dialogue boundaries, multiword names, hyphenated names, source-post names, callsigns, unit names, and pipe-delimited existing `location_v2` values.
- Consider adding an integration-level worker test that proves a database row containing existing pipe-delimited locations is preserved while only missing AI values are appended, and that `sigint_inbox_item_settlement` is reconciled.
- Add/clone focused React tests for the settlements admin page/table if parity with the callsign page tests is expected.
- Check that the new navbar-item assertion order is the desired product order.

## Migration/catalog validation

- The standard test databases already created are:
  - `wd_test_2133_settlements_ai`
  - `wd_files_test_2133_settlements_ai`
- Base-branch migrations were successfully applied to the restored standard dump.
- The catalog-before snapshot is at `target/settlement-catalog-before.tsv`.
- Applying the working-tree migration was interrupted at the user's request while Rust was recompiling. Resume with:

  ```sh
  TEST_DB_NAME=wd_test_2133_settlements_ai \
  TEST_WDFILE_DB_NAME=wd_files_test_2133_settlements_ai \
  cargo run -p wdintel-rs -- --mode=test migrate
  ```

- Then create `target/settlement-catalog-after.tsv` with the same PostgreSQL catalog query used by `scripts/ci/check_analytics_migration_catalog.sh`, and validate the uncommitted migration explicitly with the functions in `scripts/ci/check_analytics_migrations.py`.
- The prescribed command was run with `GITHUB_BASE_REF=main`, but its comparison gate skipped because `origin/main` equals `HEAD` and this migration is still untracked. Do not treat that skip as a completed catalog comparison.
- Remove the temporary detached worktree after catalog validation:

  ```sh
  git worktree remove --force target/settlement-catalog-worktree
  ```

- Optionally drop the dedicated test databases when no longer needed via the project cleanup flow.

## Tests and checks still required

- Re-run focused Rust tests using the restored standard test databases, not the stale default test database:

  ```sh
  TEST_DB_NAME=wd_test_2133_settlements_ai \
  TEST_WDFILE_DB_NAME=wd_files_test_2133_settlements_ai \
  cargo test -p wdintel-rs ai_settlement -- --nocapture
  ```

- Re-run after any edits:

  ```sh
  cargo fmt --all
  cargo check -p wdintel-rs
  cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings
  cd wdintel-web && npm run format:staged
  just build-front
  git diff --check
  ```

- `elm make` is not installed globally; `just build-front` successfully compiled the new Elm route and full frontend.
- `cargo check -p wdintel-rs` completed successfully before the last formatting pass.
- Strict clippy completed successfully.
- `just gen-front` completed successfully and updated both generated bindings.
- `just build-front` completed successfully.
- The first focused Rust test attempt failed before tests ran because the default local test database was stale/incomplete (`sigint_comment` missing). Use the restored dedicated database above.
- `just migrate-up` on the ordinary local development database remains blocked by its pre-existing applied migration `m20260827_154846_normalize_failed_unit_labels`, which is absent from this branch. Do not edit this feature migration to work around that unrelated local state.

## Final handoff

- Inspect `git status` and the complete `git diff`; ensure no generated changes from the stale local schema leaked into unrelated entities.
- Confirm `worker_enabled` is still `false` by default in the migration and no seed enables it.
- Confirm analytics exclusions and `deploy/clickhouse/migration-impact.json` list all four new tables.
- If `.env` contains `MATTERMOST_NOTIFICATION_HOOK`, send the required single completion notification only after all remaining work is finished.
- Do not commit or push without explicit user permission. If asked for a commit message, read `.github/skills/conventional-commit-branch-scope/SKILL.md` first and derive scope from branch `2133-settlements`.
