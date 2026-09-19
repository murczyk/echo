---
name: test-scope-policy
description: Decide whether to add, retain, replace, or remove automated tests under this repository's CODE_REVIEW.md policy. Use whenever implementing, proposing, or reviewing tests, fixtures, snapshots, or test-only exports.
---

# Test Scope Policy

Read the **Test scope** section of `CODE_REVIEW.md` before adding, retaining, or
removing tests.

## React Vitest placement

Place every new `*.spec.*` or `*.test.*` under `src/ts/react` as a direct child
of the nearest production-owned `__tests__/` directory. The path has exactly one
`__tests__` segment and no directory below it. Resolve collisions with a
descriptive filename in that directory. Playwright tests and support modules
belong under `tests/e2e`.

## Admission review

No in-source `@test-scope` annotation is required. Classification is a review
decision, not something developers satisfy with a label; a persuasive comment
or renamed test does not make weak coverage valuable. Existing tests must not
be deleted merely because they lack metadata. Judge new tests by the behavior
and failure mode they protect, individually within a heterogeneous suite.

Add or retain tests that protect database-backed business behavior, operational
parsing, focused Echo issue/PR regressions, critical migration/authorization/
concurrency/idempotency/destructive-data safeguards, meaningful integration
behavior, or valuable Playwright coverage. Preserve `@regression` in Playwright
titles because `e2e:regression` selects titles.

## Reject by default

- Trivial helpers, formatters, static rendering, labels, defaults, and small
  branch maps.
- Outbound serializers, request builders, local validation, eligibility maps,
  merging/deduplication, sorting, and formatting presented as parser coverage.
- Mocked implementation sequencing, prop forwarding, timer checks, or snapshots
  that do not exercise an observable failure mode.
- Production exports introduced only for direct testing.

## Removal and documentation

Inspect every candidate case before deleting it. If its unique user-visible or
operational behavior remains part of the product contract, add or confirm an
accurate behavior-contract entry before removal. Do not create ledgers,
disposition files, allowlists, or recovery artifacts.

## Self-check

For every added or retained test, identify the accepted category, concrete
failure, and observable behavior. For every removed test, confirm either that
it was an implementation detail or that its behavior contract is maintained.
