# KPI — Iteration 1

Issue: [#3826](https://github.com/echoua/echo/issues/3826). The admin-only page is `Адмін → База знань → KPI`, at `/admin/kpi`. The complete source wishlist is [idea.md](idea.md); all unresolved or unsupported work is tracked in [iteration2.md](iteration2.md).

## Scope

- Reuse ECharts already present in the frontend. Add no dependencies, API routes, schema changes, or generated backend types.
- Load the full account list from existing admin-only `POST /api/logins`; aggregate unique account IDs locally. Scope defaults to all returned accounts, including technical accounts. Role and organism filters apply to every account card, chart, and review row.
- Show retained account total, active-account count, deactivated/blocked count, status reasons, and accounts whose recorded activity is older than 90 days. Status precedence matches the Users page: account deactivation and reason first, disabled organism second, otherwise active.
- Show disjoint recorded-activity age buckets: less than 30 days, 30–90 days inclusive, over 90 days, no timestamp, and invalid/future timestamp. Use one captured UTC timestamp per successful account response. Default recency to deactivated/blocked accounts, with a switch to include active accounts.
- Show role, organism, and direction distributions. Group organizations/directions by IDs; deduplicate repeated role membership. One account may contribute to several role bars. Exact counts remain available in accessible chart tables.
- Provide a paginated stale-account review list with links to the existing admin user-details page. KPI has no account mutation controls.
- Show a separately scoped, system-wide successful-report total from existing `POST /api/admin/report-history/list`, using the `done` status filter, `limit: 1`, and returned `total`. Do not download the complete report history. Account filters do not apply to this card.
- Load account and report snapshots independently on entry and explicit refresh; provide separate retry/error states, Ukrainian error toasts, retained snapshot timestamps, and stale-result guards. Reuse shared 401/login handling.
- Reuse Admin navigation/API authorization and add a page-local role gate before mounting the React host, including while the shared user is the anonymous placeholder. Support responsive scrolling and light/dark chart colors.

## Metric limits

The account list excludes permanently deleted accounts, accounts belonging to permanently deleted organisms, and managed AI/template accounts. It cannot establish all-time registrations or period deletions. The recorded activity timestamp can change during creation, reactivation, sign-in, or keep-alive; it cannot prove a first/last login, a human action, or absence of prior logins. Account availability is distinct from engagement.

The report total counts retained history records currently in `done`; it does not count downloads or every retry/rerun. Existing analytics replication/fallback behavior may affect freshness. Its date filters are text matches, so Iteration 1 offers no historical date-range picker.

The estimated live-base card is deferred because its definition remains unclear. DAU/WAU/MAU, retention, sessions, bot engagement, and every other unsupported metric remain in Iteration 2. No empty placeholder charts are added.

## Implementation and validation

- [x] Add Elm route, guarded React host, navigation, dashboard, and chart lifecycle.
- [x] Cover #3826 authorization, scopes, boundaries, independent failures, refresh, and responsive behavior with browser regressions.
- [x] Run focused Elm compilation, frontend formatting, relevant navbar/auth regressions, browser tests, and `just build-front`.
- [x] Update the admin behavior contract and changelog.

Implementation: [Elm page](../../wdintel-web/src/Pages/Admin/Kpi.elm), [React dashboard](../../wdintel-web/src/ts/react/routes/admin-kpi/index.tsx), and [behavior contract](../../docs/frontend/react-behavior-contracts/admin-pages.md#kpi-dashboard).

Validated locally on 2026-10-22:

- `cd wdintel-web && npx elm-land generate && npx elm make src/Pages/Admin/Kpi.elm --output=/dev/null` — passed.
- `cd wdintel-web && npm run format:staged` — passed; existing-file changes are limited to the new import/menu entry.
- `cd wdintel-web && npm run test:ts -- src/ts/react/components/app-navbar/__tests__/AppNavbar.cyber-visibility.regression.spec.tsx src/ts/react/__tests__/auth-redirect.spec.ts` — 51 tests passed; includes token and test-structure checks.
- `cd wdintel-web && npx playwright test tests/e2e/admin-kpi.spec.ts --reporter=line` — all 10 KPI browser regressions passed, including 390/1280px layouts, menu navigation, actual chart rendering, date boundaries, filtering, data failures/retry, role denial, placeholder identity, and login redirect.
- The seven existing `tests/e2e/admin-users-neo.spec.ts` browser regressions passed in the initial combined run.
- `just build-front` — passed.
- Archive links, original wishlist preservation, and `git diff --check HEAD` — passed. Dependencies, API contracts, database schema, and overview READMEs are unchanged.

Staging/production changes require separate explicit approval naming the operation and target, per `AGENTS.md`.
