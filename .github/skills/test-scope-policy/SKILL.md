---
name: test-scope-policy
description: Decide whether to add, retain, replace, or remove automated tests under this repository's CODE_REVIEW.md policy. Use whenever implementing, proposing, or reviewing tests, fixtures, snapshots, or test-only exports.
---

# Test Scope Policy

Read the **Test scope** section of `CODE_REVIEW.md` before adding or expanding the default test suite.

## React Vitest placement

Place every new `*.spec.*` or `*.test.*` under `src/ts/react` as a direct child
of the nearest production-owned `__tests__` directory. A React Vitest path has
exactly one `__tests__` segment and no directory below it: never use recovery,
characterization, nested test, temporary holding directories, or placement
exceptions. Resolve collisions with a descriptive filename inside the correct
directory, and preserve resolved production imports and `vi.mock` targets during
relocation. Playwright belongs in `tests/e2e` and is not subject to this React
placement rule.

## Admission gate

Use a co-located annotation for every retained default-suite test:

```ts
// @test-scope parser: coordinate conversion fixture
// @test-scope safeguard: idempotency — prevents duplicate mutation after a repeated submit
// @test-scope regression: https://github.com/echoua/echo/pull/1234
```

Regression annotations require an Echo issue or PR URL. Safeguard annotations
must name the harmful outcome, not only a mechanism such as a timer or abort
call. File-level annotations are allowed only for homogeneous parser fixtures.
`describe` annotations are inherited, so use one only when every descendant
truthfully shares the same admission category and failure mode.
Dynamic titles and `.each` declarations are classified at their actual test
invocation. For Playwright, every Echo-linked regression annotation requires a
literal `@regression` title or describe tag, and every such tag requires that
annotation: `e2e:regression` selects tags, not comments.

Add or retain a test only when it protects at least one category accepted by `CODE_REVIEW.md`:

- database-backed business behavior
- an operational parser or fixture
- a focused regression linked in the test to an Echo issue or pull request
- a critical migration, authorization, concurrency, idempotency, or destructive-data safeguard

If none applies, do not add the test. Removing a nonqualifying test does not require replacing it.
Record any user-visible behavior left without a direct default-suite test in its
behavior contract; contract references must use complete, existing
repository-relative test paths or `No direct default-suite test; behavior is
preserved by this contract.` Do not create recovery, holding, or temporary
test/disposition artifacts.

## Reject by default

- Direct input/output restatements of trivial helpers, formatters, defaults, or small branch maps.
- Outbound serializers and request builders, default-state construction, local validation, eligibility maps, merging/deduplication, sorting, and formatting are not parser fixtures. Parser coverage consumes external API, URL, pasted/user-entered structured-text, or file-format input.
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

## Contributor decision tree

```text
Is this an operational parser fixture?
  -> Add it to the existing parser suite and annotate it as parser coverage.

Is this a critical authorization/concurrency/idempotency/destructive safeguard?
  -> Test the harmful outcome and annotate the safeguard.

Is this a known UI regression?
  -> Link the Echo issue/PR and test at the lowest faithful boundary.

Is this a label/default/style/helper assertion?
  -> Document or centralize it; do not add an isolated test.
```
