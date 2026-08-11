# Coordinates Screenshot Migration Checkpoint

## Current State

- Reviewed repository instructions from `AGENTS.md`, `README.md`, and `echo-migration/README.md`.
- Checked `echo-migration/`; it does not contain its own `AGENTS.md`, so parent repo instructions apply.
- Added `coordinates_screenshot` provisioning to `goi/echo-swapp/src/automation.rs` startup schema setup.
- Added Echo undo migration:
  - `echo-migration/src/m20260811_174133_drop_echo_automation_coordinates_screenshot.rs`
  - `up`: drops `echo_automation.coordinates_screenshot`
  - `down`: recreates it as `boolean not null default false`
- Registered the new Echo migration in `echo-migration/src/lib.rs`.
- Added analytics impact metadata in `deploy/clickhouse/migration-impact.json`.
- Regenerated `wdintel-rs` SeaORM entities and kept the intended generated change:
  - removed `coordinates_screenshot` from `wdintel-rs/src/entities/echo_automation.rs`
- `echo-swapp` does not appear to have generated SeaORM entities; it uses explicit SQL/result structs in `goi/echo-swapp/src/automation.rs`.

## Verification Already Done

- `cargo fmt -p echo-migration -p echo-swapp -p wdintel-rs`: passed.
- `cargo check -p echo-migration -p echo-swapp -p wdintel-rs`: passed.
- `cargo clippy -p echo-migration -p echo-swapp -p wdintel-rs --all-targets --all-features -- -D warnings`: passed.

## Local Issues Encountered

- `just migrate-up` did not complete because local DB `seaql_migrations` contains applied versions whose migration files are missing:
  - `m20260811_161634_failed_inbox_unit_multi_text`
  - `m20260811_142447_failed_inbox_unit_note`
- For codegen only, the new drop SQL was manually applied to local `wd` and the new migration marker was inserted.
- `just gen-seaorm` initially needed the patched `sea-orm-cli 2.0.1` that supports `--include-generated-columns`; it was installed from the cached patched checkout.
- `just gen-seaorm` produced unrelated entity drift because the local DB schema is not a clean canonical migration baseline. Unrelated generated files were reverted, leaving only the intended `echo_automation` entity change.

## Pending Work

- Decide how to handle the local stale migration markers before rerunning `just migrate-up` cleanly.
- Rerun `just migrate-up` after local migration history is fixed or against a clean database.
- Rerun `just gen-seaorm` against a clean canonical database if a fully clean generated pass is required.
- Run the catalog-aware analytics migration check on a proper branch/commit baseline:
  - `source deploy/setup_test_database.sh <branch-safe-name>`
  - `GITHUB_BASE_REF=<base-branch> TEST_DB_NAME="$DB_NAME" scripts/ci/check_analytics_migration_catalog.sh`
- Confirm whether a `CHANGELOG.md` entry is expected for this schema ownership move.
- If deploying to `goi-stg`, deploy the updated `echo-swapp` binary and verify worker logs no longer show `column "coordinates_screenshot" does not exist`.

## Current Changed Files

- `deploy/clickhouse/migration-impact.json`
- `echo-migration/src/lib.rs`
- `echo-migration/src/m20260811_174133_drop_echo_automation_coordinates_screenshot.rs`
- `goi/echo-swapp/src/automation.rs`
- `wdintel-rs/src/entities/echo_automation.rs`

## Notes

- No commit or push has been made.
- The original Echo migration `m20260810_062938_echo_automation_coordinates_screenshot.rs` was not edited.
