---
name: frontend-regression-safety
description: Run mandatory frontend regression safety checks for API contract compatibility and UX/UI stability before finishing UI behavior changes.
---

# Frontend Regression Safety

## Short description (for triggering)
Use at the end of any task that changes frontend behavior, API calls, UI states, or route flows.

## When to use / When NOT to use
- Use: Any Elm/React/UI behavior change.
- Use: Any edit in `wdintel-web/src` that touches network calls or interactions.
- Do not use: Pure docs-only changes.
- Do not use: Pure commit message drafting with no code change.

## Inputs the agent should request or derive
- Derive changed endpoints from diffs in Elm effects or `services/api/*`.
- Derive impacted screens/routes from changed components/pages.
- Derive available test/build scripts from `justfile` and `wdintel-web/package.json`.
- Derive whether touched UI state is URL-backed, localStorage-backed, or user-settings-backed.

## Procedure (checklist)
- REST API contract checks:
- Confirm endpoint paths and methods unchanged unless explicitly intended.
- Confirm request body keys and response parsing still match backend shape.
- Confirm status handling remains correct (especially 401 behavior).
- If contract changed intentionally, update all together:
- client code
- generated/shared types
- mocks/tests
- docs/changelog note
- UX/UI regression checks:
- For React layout changes, confirm native structure, Tailwind layout, MUI/Power interaction components, and shared Echo tokens are preserved. See [`docs/frontend/layout-component-contract.md`](../../../docs/frontend/layout-component-contract.md).
- Verify layout at mobile/tablet/desktop.
- Verify keyboard navigation and focus state visibility.
- Verify loading, empty, error, success states.
- Verify no break in core flows for impacted page routes.
- For Duty/MessageCard changes, verify inactive hidden feeds do not produce read or scrolling side effects; scroll anchoring/windowing remains stable; closed menus/dialogs remain unmounted where required; theme-aware typography and geometry remain consistent; shared Analysis functionality remains intact; native hot-path structure has not been replaced by MUI layout wrappers.
- State persistence checks:
- For `TableStateProvider`, verify URL-backed `globalFilter`, `columnFilters`, `sorting`, and non-default `date` remain shareable and back-button aware.
- Verify localStorage-backed table layout (`tableId` column visibility/order/sizing/toggles) survives reload and handles stale columns.
- For saved filters, verify apply/update/save-as-new/rename/delete dirty-state behavior and duplicate/empty names where relevant.
- For `/api/user/settings`, verify settings normalize defaults, save failures surface, rapid toggles preserve the latest value, and other mounted surfaces receive update events.
- Run project checks:
- `just build-front`
- For Elm-heavy changes: `cd wdintel-web && elm make <touched>.elm --output=/dev/null`
- For TS-heavy changes when feasible: `cd wdintel-web && npm run test:ts`
- For message-card preview E2E changes, including shared preview shell/config/capabilities, preview dialogs/stages/actions/controls, `MessageCardContent`, and attachment-preview classification, run `cd wdintel-web && npx playwright test tests/e2e/message-card-media-preview.spec.ts`, and keep the smoke cases tagged `@smoke`.
- If Chromium is unavailable, report the exact failure and request approval before running `cd wdintel-web && npm run e2e:install`; rerun the focused spec after installation.
- If the local server or browser still cannot run, report the exact blocker and do not claim full E2E verification.
- If tests are missing for changed logic, add or extend unit/component tests where feasible in same change.

## Definition of Done (checklist)
- API contract compatibility verified or intentionally migrated.
- UX regression checks completed across breakpoints and states.
- Relevant URL/localStorage/user-settings persistence behavior is verified.
- Relevant build/tests pass.
- Any necessary type/mock/doc updates are included.
- No silent handling regressions for API errors.

## Tiny examples
```txt
Changed /api/palitra/update/:id body?
-> Update request mapper + response normalizer + related tests in same change.
```

## Self-check
- Re-open diff and list each changed endpoint/method.
- Re-open diff and list each changed interactive UI state.
- Confirm every list item is either validated or intentionally changed and documented.
- Confirm no unrelated files were modified.
- Confirm no new layout-only `Box`, `Stack`, `Grid`, `Container`, or structural `sx` was introduced.

## Assumptions
- Manual visual verification is acceptable when automated UI tests are absent.
