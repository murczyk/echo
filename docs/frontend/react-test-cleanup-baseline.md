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

- `src/ts/react/routes/rer-networks-neo/use-rer-networks-neo-page.spec.tsx` — `requests activity data with a concrete upper bound and maps returned bars` expects an API request without the now-present `period: null` field.

The run also emitted existing Happy DOM requests to the unavailable local API on port 3000, including `ECONNREFUSED`, `ECONNRESET`, and abort messages. These messages did not create additional failed Vitest tests.

## Playwright

Command:

```text
npx playwright test
```

Result: 45 generated Chromium tests: 20 passed and 25 failed in about 1.3 minutes. The configured retry count was zero outside CI.

Baseline environment failures include Vite `504 Outdated Optimize Dep` responses and route fixtures resolving to the generic `ЕХО` page instead of their expected application route. Affected areas include Analysis Neo, Device Details, Duty, Message Card previews, MRT overflow, and page-load performance comparisons. The failing visual/performance tests are baseline failures, not evidence for cleanup changes.

## Baseline decision

No browser or Vitest test is removed solely because of this baseline. Replacement coverage is not treated as valid until the Playwright workflow is enabled and stable in CI.

## Admission-gate inventory

`node scripts/test-scope-check.mjs` now scans only `src/ts/react` and `tests/e2e`. The checked-in `test-scope-baseline.json` records 2,189 exact legacy test identities. This is the explicit migration backlog: the gate passes for that baseline, rejects new unclassified tests, and permits only explicit baseline updates that shrink it.

The gate was verified with an uncommitted temporary rename of a legacy
`PowerSnackbar` test: it reported the renamed identity as new debt and the
original identity as resolved debt. The title was restored without updating the
baseline.

## Mutation proof

- 2026-08-24 — The shared API-client authorization safeguards replaced
  `auth-redirect.spec.ts`. Three temporary, uncommitted mutations each made
  `npx vitest run src/ts/react/services/api/client.spec.ts` fail: allowing a
  redirect on `/login` failed the redirect-loop case; returning `null` for a
  401 failed the unauthorized-rethrow case; and treating a 500 as unauthorized
  failed the non-401 session-preservation case. Each mutation was reverted and
  the replacement suite then passed.

Other previously removed React specs remain restored pending subsystem-specific
replacement proof.
