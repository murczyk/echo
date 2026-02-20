---
name: frontend-api-contract-change
description: Safely implement intentional frontend REST contract changes by updating endpoints, request/response mapping, generated types, and dependent tests/docs together.
---

# Frontend API Contract Change

## Short description (for triggering)
Use when endpoint path/method/body/response/status handling must change (not just internal refactor).

## When to use / When NOT to use
- Use: Intentional API contract changes in Elm or React clients.
- Use: Any modification in `wdintel-web/src/ts/react/services/api/*` or Elm API wiring that alters wire format.
- Do not use: UI-only changes with same API contract.
- Do not use: Pure commit/changelog-only tasks.

## Inputs the agent should request or derive
- Derive old vs new contract from diffs.
- Derive impacted callers from ripgrep usage.
- Derive whether backend-generated bindings need regeneration.
- Ask only if backend contract intent is unclear.

## Procedure (checklist)
- Document contract delta in task notes:
- endpoint path
- HTTP method
- request body/query schema
- response schema
- status behavior
- Update code in lockstep:
- API client method
- response normalization/parsing
- all call sites
- generated/shared types (`just gen-front` if needed)
- tests/mocks/fixtures
- Update user-facing error behavior:
- Elm: use `formatErrorForShowErrorWithDetails`.
- React: surface error in UI and keep 401 redirect behavior.
- Run checks:
- `just build-front`
- `cd wdintel-web && npm run test:ts` when TS API code changed

## Definition of Done (checklist)
- Every contract delta is reflected across client, types, and call sites.
- No stale old endpoint/path or payload key remains.
- Errors remain visible to users and 401 flow is preserved.
- Related tests or fixtures updated.
- Build passes.

## Tiny examples
```txt
Changed response key `data` -> `items`
-> update normalizer + call-site reads + tests in same patch.
```

## Self-check
- Grep for old endpoint/path/key to ensure no stale usage.
- Verify breakpoints and UI states on at least one affected screen.
- Verify no implicit status-code assumptions were broken.
- Review diff for accidental unrelated API edits.

## Assumptions
- Backend counterpart exists or is being updated in the same branch/PR.
