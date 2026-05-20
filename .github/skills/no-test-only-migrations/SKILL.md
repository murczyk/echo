---
name: no-test-only-migrations
description: Enforce a strict rule against adding or editing database migrations just to make tests pass, debug setup, or work around broken test bootstrap in this repo.
---

# No Test-Only Migrations

## Use When

- A test fails and the tempting fix is to add a migration.
- A DB bootstrap, fixture, or local test setup is broken.
- A schema change is not part of the actual feature request.

## Rule

Do not add, edit, or delete migrations just to:

- make a test pass
- repair local test setup
- unblock a bootstrap failure
- hide a schema mismatch during debugging

If the product requirement truly needs a schema change, do the migration only as part of that feature.

## What To Do Instead

- Fix the production code path first.
- Fix the test fixture, bootstrap, or migration runner if the failure is in test infrastructure.
- Use existing migrations and schema state to diagnose the issue.
- If the database is genuinely inconsistent, stop and explain the exact repair needed before editing migrations.

## Self-Check

- Am I changing schema because the feature needs it, or only because tests are noisy?
- Can this be fixed in code, tests, or bootstrap instead?
- Would this migration still make sense if tests were green already?

## Hard Stop

If the only reason for a migration is "just to test out stuff," do not create it.
