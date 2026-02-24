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
- Verify layout at mobile/tablet/desktop.
- Verify keyboard navigation and focus state visibility.
- Verify loading, empty, error, success states.
- Verify no break in core flows for impacted page routes.
- Run project checks:
- `just build-front`
- For Elm-heavy changes: `cd wdintel-web && elm make <touched>.elm --output=/dev/null`
- For TS-heavy changes when feasible: `cd wdintel-web && npm run test:ts`
- If tests are missing for changed logic, add or extend unit/component tests where feasible in same change.

## Definition of Done (checklist)
- API contract compatibility verified or intentionally migrated.
- UX regression checks completed across breakpoints and states.
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

## Assumptions
- Manual visual verification is acceptable when automated UI tests are absent.
