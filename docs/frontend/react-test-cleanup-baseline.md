# React test-cleanup baseline

Recorded on 2026-08-24 before the React test-scope migration.

## Current commands

- `npm run test:ts` runs the complete Vitest suite.
- At the time this baseline was captured, `npm run test:ts:ci` ran only three selected specs and did not represent the React behavior surface. It now runs `test:ts:gate`.
- The Playwright workflow is disabled in `.github/web-e2e.yml.disabled`; browser coverage is not currently blocking CI.

## Vitest

Command:

```text
npx vitest run --maxWorkers=1 --fileParallelism=false
```

Result: 352 files and 2,845 tests passed; one file and one test failed in 181.54 seconds.

Baseline failure:

- `src/ts/react/routes/rer-networks-neo/__tests__/use-rer-networks-neo-page.spec.tsx` — `requests activity data with a concrete upper bound and maps returned bars` expects an API request without the now-present `period: null` field.

The run also emitted existing Happy DOM requests to the unavailable local API on port 3000, including `ECONNREFUSED`, `ECONNRESET`, and abort messages. These messages did not create additional failed Vitest tests.

## Playwright

Command:

```text
npx playwright test
```

Result: 45 generated Chromium tests: 20 passed and 25 failed in about 1.3 minutes. The configured retry count was zero outside CI.

Baseline environment failures include Vite `504 Outdated Optimize Dep` responses and route fixtures resolving to the generic `ЕХО` page instead of their expected application route. Affected areas include Analysis Neo, Device Details, Duty, Message Card previews, MRT overflow, and page-load performance comparisons. The failing visual/performance tests are baseline failures, not evidence for cleanup changes.

A 2026-08-28 fresh-server run (`PORT=4190 npx playwright test --retries=0`)
started Chromium cleanly and initially passed 23 of 45 tests. After removing
six static CSS/typography checks and aligning the message-card fixture with the
current mixed attachment-preview flow, `PORT=4203 npx playwright test --retries=0`
passed 27 of 39 tests. The remaining 12 failures are Analysis route selectors,
Duty scroll stability, and unstable performance thresholds rather than Vite
`504` startup failures. The browser workflow therefore remains non-blocking
until those failures are made reproducible and resolved.

## Baseline decision

No browser or Vitest test is removed solely because of this baseline. Replacement coverage is not treated as valid until the Playwright workflow is enabled and stable in CI.

## Final checkpoint — 2026-09-09

- Scope debt: zero new debt and zero legacy debt.
- Vitest gate passed 315 files and 2,622 tests; `just build-front` passed.
  Local unavailable-API warnings remain expected Happy DOM noise when a test
  intentionally reaches the absent development API.
- A fresh one-worker, no-retry smoke run passed all 30 browser tests. Static
  layout checks were removed; fixture responses now cover the required system
  settings and short-state feature configuration.
- Linked browser regressions are selected with `@regression`.

### Playwright classification evidence

- Smoke completed 30/30 tests with one worker and no retries.
- Regression had one `image-editor-drawer` Duty case fail once, then pass both
  alone and in the complete regression run.
- The complete suite completed 44/48 tests. Its four failures are confined to
  `@perf`: Analysis delayed shell measured about 3289 ms against a 3000 ms
  limit, while the Classic Callsigns, Palitra, and Messenger headings were not
  found.

## Historical admission-gate inventory

The following checkpoints are historical. The current checked-in
`test-scope-baseline.json` is empty; the gate rejects newly unclassified tests.

The gate was verified with an uncommitted temporary rename of a legacy
`PowerSnackbar` test: it reported the renamed identity as new debt and the
original identity as resolved debt. The title was restored without updating the
baseline.

2026-08-29 image-editor and Network activity batch: the scope checker now
accepts truthful suite-level annotations inherited by each test declaration,
without treating a comment after imports as a file-level annotation. The batch
classified issue-backed regressions for [#3099](https://github.com/echoua/echo/issues/3099),
[#3294](https://github.com/echoua/echo/issues/3294), and
[#3329](https://github.com/echoua/echo/issues/3329); two isolated cosmetic
preview assertions were removed. The explicit baseline update reduced legacy
debt from 2,170 to 2,159 identities.

The same audit removed two unsupported analysis performance thresholds and the
dynamic classic-versus-Neo page-load comparison suite. Neither carried an Echo
performance contract, measurement rationale, or stable CI environment. The
explicit baseline update then reduced debt to 2,157 identities.

A focused Snackbar audit retained only the FIFO and exit-transition loss/order
safeguards, removed static roles, duration, generated-style, and render-count
checks, and reduced the explicit baseline to 2,144 identities.

The isolated Duty scroll-FAB position resolver table was removed: it only
restated style tokens and responsive defaults from production configuration.
The baseline now records 2,143 identities.

The issue-backed shared message-form keyboard-submit regression for
[#2746](https://github.com/echoua/echo/issues/2746) was documented and
classified at its shared keyboard boundary, reducing the baseline to 2,130
identities.

The unused dense-table URL helper spec was removed as isolated default/query
mapping coverage with no production consumer. The baseline now has 2,127
identities.

The frontend role hierarchy and Device capability tests were documented as an
authorization safeguard, reducing the baseline to 2,124 identities.

The login-option batch retained the AI-managed selection loss safeguard and
removed isolated sort/display/default handling; the baseline now has 2,121
identities.

The MRT row-action batch retained modal-focus and disabled destructive-action
safeguards, removed static sizing/menu-action assertions, and reduced the
baseline to 2,115 identities.

The message-card attachment-preview configuration table was removed after the
attachment-preview contract documented its shell behavior; it only restated
static production configuration. The baseline now has 2,114 identities.

The AI-agent request deep-link trim/default helper tests were removed as
isolated URL parsing coverage without an issue-backed route regression. The
baseline now has 2,112 identities.

The Admin AI-agent batch removed isolated duration, static field-order, and
table-column-order assertions. The baseline now has 2,109 identities.

The shared date/time and bulk-autocomplete batches removed isolated
formatting, JSX structure, style, prop-forwarding, and label assertions while
retaining draft ownership, bounded values, duplicate prevention, and ambiguous
selection safeguards. The baseline now has 2,048 identities.

The shared MRT frame batch removed four isolated style-object assertions after
recording the list/workspace frame contract. The baseline now has 2,044
identities.

The active-filter batch removed direct preview/label/default helper assertions
and kept the live table-state interaction coverage. The baseline now has 2,039
identities.

The shared alert batch recorded the severity/dismissal policy and removed seven
isolated timeout/default-render assertions. The baseline now has 2,032
identities.

The `PowerForm` batch linked its real keyboard interaction coverage to
[#2746](https://github.com/echoua/echo/issues/2746) and removed four ordinary
native-submit/default assertions. The baseline now has 2,023 identities.

The `EchoChip` batch removed its two static native-element/class assertions;
the component README already owns its anchor/button/span contract. The baseline
now has 2,021 identities.

The searchable-option batch documented the selection/input ownership rule and
removed two mocked selection-sequencing assertions. The baseline now has 2,019
identities.

The shared MRT-cell text formatter table was removed as isolated trim/default
coverage; the formatter and shared `NO_DATA_LABEL` remain the production source
of truth. The baseline now has 2,017 identities.

The profile-navbar batch documented parent-owned navigation, theme, and logout
delegation and removed seven mocked callback/render checks. The baseline now
has 2,010 identities.

The navbar menu-tree batch documented role/feature composition and removed 15
isolated tree, label, URL-default, and active-name assertions. The baseline now
has 1,995 identities.

The changelog-navbar batch documented maintenance/changelog state ownership and
removed eight mocked callback, timer, and rendering checks. The baseline now
has 1,987 identities.

The root-navbar batch removed 17 static visibility, child-wiring, and menu
rendering assertions. Role authorization safeguards remain in the shared role
resolver suite, while navbar composition is documented. The baseline now has
1,970 identities.

The Saved Filters failure-recovery case is documented and classified as a
draft-loss safeguard. The baseline now has 1,969 identities.

Two static Saved Filters empty-state/tooltip assertions were removed. The
baseline now has 1,967 identities.

One further static Saved Filters selection/render assertion was removed. The
baseline now has 1,966 identities.

Two additional static Saved Filters action-menu assertions were removed. The
baseline now has 1,964 identities.

## Mutation proof

- 2026-08-24 — The shared API-client authorization safeguards replaced
  `auth-redirect.spec.ts`. Three temporary, uncommitted mutations each made
  `npx vitest run src/ts/react/services/api/__tests__/client.spec.ts` fail: allowing a
  redirect on `/login` failed the redirect-loop case; returning `null` for a
  401 failed the unauthorized-rethrow case; and treating a 500 as unauthorized
  failed the non-401 session-preservation case. Each mutation was reverted and
  the replacement suite then passed.

Other previously removed React specs remain restored pending subsystem-specific
replacement proof.

## Follow-up verification

- 2026-08-28 — `npm run test:ts:gate` passed the scope check and most recently
  completed with 357 files and 2,877 tests passing. Its only failure remained the known
  RER Networks request-shape assertion: the request now includes `period: null`
  and an abort signal.
- 2026-08-28 — A serial `npx vitest run --maxWorkers=1` reproduced the known
  RER Networks assertion failure, then stopped making progress while
  browser-adjacent Happy DOM tests attempted unavailable local API requests.
  It did not reach a final aggregate result. This is an environment limitation
  distinct from the admission-gate result; `npm run test:ts:scope-check`
  remains green.
- 2026-08-28 — Removed only individually audited test cases that assert
  trivial formatting, static table/menu configuration, ordinary prop
  forwarding, or request-builder defaults. Focus, destructive-action,
  authorization, response-normalization, and live-feed state-machine coverage
  remains in the default suite.
- 2026-08-28 — Restored test files removed without mutation or stronger-boundary
  proof and restored their existing identities to the legacy baseline. They
  remain candidates for later subsystem-specific cleanup; this corrective
  restoration is not an admission of new test debt.
- 2026-08-28 — Removed the compiled-CSS opacity assertion and arbitrary
  14px typography variants from the message-card Playwright file. A clean-port
  run of its remaining interaction and responsive tests passed 4 of 6; the two
  failures occur first in the shared media fixture, which no longer exposes the
  expected image buttons.
- 2026-08-29 — After the shared date/time, bulk-autocomplete, and MRT helper
  cleanup batches, `npx vitest run --maxWorkers=1 --fileParallelism=false`
  passed 375 files and 2,909 tests in 144.71 seconds. Happy DOM again emitted
  unavailable-local-API reset/refusal and aborted-fetch noise, but no test
  failed.
- 2026-08-29 — After the subsequent Power, chip, autocomplete, and navbar
  cleanup batches, the same serial command passed 369 files and 2,870 tests in
  143.16 seconds. The previously recorded unavailable-local-API Happy DOM
  messages again did not fail a test.
- 2026-09-01 — The first RER Analysis homogeneous-suite audit removed 31
  static/helper identities. The remaining baseline is 1,933 identities;
  retained map-payload and report-request fixtures are explicitly admitted as
  compatibility parsers.
- 2026-09-01 — The next RER Analysis component-suite audit removed 59 static
  rendering, control-wiring, and layout identities. The remaining baseline is
  1,874; retained activity/card request cases name their user-visible stale or
  unrequested-load safeguards.
- 2026-09-01 — RER Analysis filter-reload, page-state, and message-pagination
  suites were audited as homogeneous compatibility/concurrency coverage. Their
  82 identities are now admitted through suite annotations; the remaining
  baseline is 1,756.
- 2026-09-01 — The remaining RER Analysis data-loader, mutation, map, report,
  sidebar, editor, saved-filter, and comment suites were classified as
  compatibility or stale-state safeguards. The remaining baseline is 1,635.
- 2026-09-01 — RER Analysis is fully audited: its remaining presentation and
  mocked-composition suites were removed, leaving no baseline identities under
  `routes/rer-analysis-neo`. The serial Vitest suite passed 346 files and
  2,622 tests in 175.52 seconds despite expected unavailable-local-API noise.
- 2026-09-01 — Shared routes cleanup began: 15 trivial helper identities were
  removed, while mapper/validation/copy/event boundaries and the real
  Manage Message drawer lifecycle were explicitly admitted. The remaining
  baseline is 1,426.
- 2026-09-01 — Removed the mocked Message Card presentation/configuration
  suite (112 identities). Its documented interaction and preview contracts
  remain covered at admitted boundary/browser levels; the baseline is 1,314.
- 2026-09-01 — Removed 41 static attachment-renderer identities. OCR preview,
  settlement autocomplete, and marked-message node coverage remain admitted as
  stale-response or parser safeguards; the baseline is 1,206.
- 2026-09-01 — Shared routes are fully audited: the remaining coordinate,
  preview-shell, document-renderer, and label suites were removed or admitted
  at their real parser/safeguard boundaries. The serial suite passed 320 files
  and 2,339 tests in 131.95 seconds; no shared-route baseline identities remain.
- 2026-09-01 — Duty Neo is fully audited: feed parsing, polling, unread,
  mutation, directional-load, and scroll-state suites are admitted safeguards;
  mocked presentation suites were removed. The serial suite passed 313 files
  and 2,283 tests in 173.78 seconds; no Duty Neo baseline identities remain.
- 2026-09-01 — Network Details Neo is fully audited: network relation,
  callsign, frequency, load, form, and report boundaries are admitted while
  mocked component/presentation suites were removed. The baseline is 534;
  no Network Details Neo identities remain.
