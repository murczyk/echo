# Stabilization validation (#3780)

Branch: `3780-stabilize-fixes`, based on `main` at `f1c915695`.
The results below record the initial implementation checks against the deployed
`stable` baseline `ad2678da257`; the restored main-based branch requires its own
verification, including retained Exact/Substring search and newer migrations.
Validation date: 15 October 2026. No production deployment or settings/schema
changes were performed. Production diagnostics used the existing unlocked SSH
agent and bounded read-only SQL; raw queries and parameters remain private.

## Results

- **212 Rust tests passed; one existing benchmark ignored.** This covers the
  Analysis, inbox, attachments and request-deadline suites, including AOR union
  membership/counts/cursors, authorization, mixed body/attachment and negative
  search, tag ownership/model/unit/duplicate-association semantics, scoped
  changes, former/deleted owners, startup coverage, overflow and bounded cleanup.
- **74 frontend tests passed** across the five Duty/settings suites carrying
  #3546 creation-time regressions. No frontend code changed.
- **`just build-front` passed.**
- **`cargo check -p wdintel-rs -p echo-migration` passed** after the final
  deadline/cleanup correction.
- **`cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings`
  passed.** Cargo still reports an existing dependency future-compatibility
  notice for `proc-macro-error2`; there are no project Clippy warnings.
- **Migration catalog policy check passed** with `GITHUB_BASE_REF=stable` on
  `wd_test_3780_catalog_20261015`, restored from the standard dump. This compares
  actual base/proposed catalogs and validates both source-only exclusions.
- **Migration down/up passed** on that separate catalog database. Down removes
  the ledger/column; up restores them. Existing singleton triggers remain.
- **`just migrate-up` passed** on `wd_test_3780_stabilize_20261015` after the
  normal full dependency migration sequence. Generated the new entity and
  singleton field with `just gen-seaorm`; unrelated generator/formatter changes
  were removed. `npm run format:staged` and whitespace checks passed.

The broad Rust run initially found a missing local NLP service; the existing
Python virtual environment was reused to start the real service for testing.
The affected legacy submission test and the full selected suite then passed.
The temporary service was stopped afterward. The isolated callsign benchmark
remains ignored by its existing default-suite declaration.

## Reproduction

Use dedicated databases restored with `deploy/setup_test_database.sh`; do not
point these fixture tests at a development or production database containing
valuable data. Ensure the real local NLP service is ready on port 5000.

```bash
TEST_DB_NAME=wd_test_3780_stabilize_20261015 \
TEST_WDFILE_DB_NAME=wd_files_test_3780_stabilize_20261015 \
cargo test -p wdintel-rs -- \
  rer_importer::analysis::tests rer_importer::inbox::tests \
  attachments::tests server::read_deadline::tests --test-threads=1

cargo check -p wdintel-rs
cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings
just build-front

source deploy/setup_test_database.sh 3780_catalog_20261015
GITHUB_BASE_REF=stable TEST_DB_NAME="$DB_NAME" \
  scripts/ci/check_analytics_migration_catalog.sh
```

Local PostgreSQL 14 required its installed `pg_uuidv7` extension before the
standard full migrations. Production already has its UUID generation setup.

## Performance evidence and limits

[Implementation measurements](implementation_measurements.json) retain
sanitized timings, reads, memory and diagnostic limits. The selected-AOR count
and resolved-access sender aggregate each plan as one foreign scan; native
executions finished in 2.54 and 1.52 seconds, with about 222 MiB and 809 MiB
tracked memory. At 19:29:45 UTC, Pivnich/Skhid/Siversk had 9/15/6 documents
updated in the preceding 90 seconds. This sample is below the 1,000-ID guard
limit but does not establish peak change volume. Source quoted matching
improved in the short sample, but wider
probes remain unresolved. These are diagnostic SQL results, not HTTP latency or
concurrent capacity guarantees.

The cleanup regression exposed a PostgreSQL nested-loop semi-join that
reevaluated the locking LIMIT subquery for each deleted row. A materialized CTE
now selects the batch once; a 1,001-row fixture leaves exactly 501 after one
500-row cleanup, including on the indexed production-shaped table.

The Actix deadline regression verifies that a queued read expires with the
503/Retry-After response and releases its mutex waiter. The middleware retains
only the path, avoiding Actix's prohibition on cloning a request before routing.
Submitted database work is still governed by existing statement timeouts;
immediate PostgreSQL/ClickHouse cancellation and resource caps require the
follow-up investigation in [next_steps.md](next_steps.md).

Production rollout/soak, including Siversk's fallback saturation, remains to be
performed using the [rollout steps](plan.md#rollout-and-recovery).
