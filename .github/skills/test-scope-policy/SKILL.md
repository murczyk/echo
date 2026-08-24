---
name: test-scope-policy
description: Decide whether to add, retain, replace, or remove automated tests under this repository's CODE_REVIEW.md policy. Use whenever implementing, proposing, or reviewing tests, fixtures, snapshots, or test-only exports.
---

# Test Scope Policy

Read the **Test scope** section of `CODE_REVIEW.md` before adding or expanding the default test suite.

## Admission gate

Add or retain a test only when it protects at least one category accepted by `CODE_REVIEW.md`:

- database-backed business behavior
- an operational parser or fixture
- a focused regression linked in the test to an Echo issue or pull request
- a critical migration, authorization, concurrency, idempotency, or destructive-data safeguard

If none applies, do not add the test. Removing a nonqualifying test does not require replacing it.

## Reject by default

- Direct input/output restatements of trivial helpers, formatters, defaults, or small branch maps.
- Static rendering tests for column order, headings, labels, icons, classes, or component configuration.
- Mock-heavy tests that only assert props, timers, local state sequencing, or other implementation details without exercising the real failure mode.
- Snapshots or shallow renders whose failure would only indicate an intentional markup/configuration edit.
- Production exports introduced solely to make a private helper directly testable.

## Prefer meaningful coverage

- State the user-visible, operational, or safety failure the test would catch before writing it.
- Prefer an existing functional test or operational fixture over a new isolated test.
- For issue/PR regressions, include the stable Echo issue or pull-request reference in the test.
- Exercise observable behavior through the production boundary. For UI focus, modal, layout, or browser-navigation defects, use the lowest test level that can reproduce the real interaction; do not substitute mocked prop sequencing.
- Running relevant existing tests is always appropriate and does not imply that new tests must be added.

## Self-check

Before finishing, review every added or substantially expanded test and ask:

1. Which accepted category admits this test?
2. What real failure does it catch?
3. Is that failure exercised, rather than an implementation mechanism merely restated?
4. If it is a regression test, is the Echo issue or pull request linked in the test?

Delete or rewrite the test if these questions do not have concrete answers.
