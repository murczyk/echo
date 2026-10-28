# AI queue monitoring and fallback implementation

Prepared locally on 2026-10-27 in Echo branch `3888-double-callsign` and
`/home/ubuntu/workspace/echo-sergeant` branch `3888-ai-queue-monitoring`.
The feature has not been deployed. This implementation did not change any
production queue or engine configuration.

The behavior and rollout contracts live in
[AI queue reliability](../../wdintel-rs/src/ai_worker/README.md),
[operational monitoring](../../wdintel-rs/src/server/README.md), and
[Sergeant's component README](../../../echo-sergeant/echo-sergeant/README.md).
Existing engine selections remain primary, with no fallback selected by the
migration. Luna/Gemma selection is available after deployment. Both projects
must be updated for live AI alerts.

## Validation

| Check | Result |
| --- | --- |
| Echo `cargo check -p wdintel-rs -p echo-migration` | Passed |
| Echo `cargo clippy -p wdintel-rs -p echo-migration --all-targets -- -D warnings` | Passed, including final validation-error correction |
| Callsign worker suite | 7 passed |
| Settlement worker suite | 13 passed |
| Position worker suite | 11 passed, including fallback-engine provenance |
| Concurrent engine-disable/settings-save regression | Passed; rejection retains its user-facing validation message |
| `just build-front` | Passed |
| Affected Playwright suites | 11 passed; primary/fallback workflows also reran successfully with callsign settings at phone width |
| Frontend Vitest suite | 3,522 passed; one unchanged message-feed timing test failed |
| Isolated message-feed rerun | All 42 tests passed |
| Sergeant tests | 4 passed, including old payloads, queue overrides, stalled/lagging/overdue work, startup, idle, and disabled queues |
| Migration up/down/up and catalog policy | Passed against a dedicated database restored from the standard dump, with `GITHUB_BASE_REF=main` |
| Entity and frontend binding generation | Completed against the migrated test database |
| Whitespace checks in both repositories | Passed |

Final worker reruns used a copy of the test executable built by Cargo for the
successful concurrency regression. Test names were verified before running;
all three worker suites passed again after the final backend changes. Database
tests used `wd_test_3888_ai_workers_20261027_1540` and its dedicated file database.

The repository's test executable runs database initialization before processing
`--list`. One initial direct-list attempt omitted the dedicated database
variables and stopped in the default local test database at a missing baseline
table (`sigint_comment`); it did not execute worker tests. The corrected listing
used `WDINTEL_SKIP_TEST_DB_INIT=1`, and execution used the explicit restored
database names before process startup.

Existing whole-workspace formatter differences remain in generated entity
module ordering and `messenger_ingest/mod.rs`; modified Rust code was formatted
without adding that unrelated churn. Sergeant's Clippy run completes with
existing warnings in its build script, heartbeat code, and Kibana code; strict
`-D warnings` therefore remains blocked there. No warning points at the new
AI checker.

See [query review](monitoring-query-review.md) and the saved plans for the
2,000,000-job monitoring benchmark and the 60-second AI snapshot cache.
