---
name: frontend-react-mui-implementation
description: Implement or refactor React + MUI features in wdintel-web/src/ts/react using custom-element entrypoints, useNeoMuiTheme, and typed API service patterns.
---

# Frontend React+MUI Implementation

## Short description (for triggering)
Use when editing TSX React routes/components or custom element wrappers in `wdintel-web/src/ts/react`.

## When to use / When NOT to use
- Use: React pages/components, MUI UI updates, API service usage in TS.
- Use: Files under `wdintel-web/src/ts/react/routes`, `components`, `services/api`, `*-element.tsx`.
- Do not use: Elm-only changes.
- Do not use: Commit/changelog-only requests.

## Inputs the agent should request or derive
- Derive target custom element tag from related Elm page (for hybrid pages).
- Derive existing theme/style conventions from nearby component.
- Derive API shape from `Bindings` types and `services/api/*`.
- Ask only if the mount target element/tag is unclear.

## Procedure (checklist)
- Keep hybrid mount pattern:
- `createRoot(this)` in custom element class.
- Wrap route root with `ThemeProvider` + `useNeoMuiTheme`.
- Reuse API client helpers from `services/api/client.ts`:
- `postJson/getJson/postVoid/...`
- Throw/handle `HttpRequestError`.
- Handle 401 with `isUnauthorizedError(error)` and redirect:
- `window.location.assign('/login')`
- Keep UI errors visible via `Alert` or established UI messaging pattern.
- Prefer existing styling mix:
- MUI `sx` for component-level styles.
- Existing utility classes (`className`) where already used.
- Keep functions focused; split large handlers/helpers.
- Run frontend verification:
- `just build-front`
- Run targeted TS tests if touched:
- `cd wdintel-web && npm run test:ts`

## Definition of Done (checklist)
- Custom element still mounts/unmounts correctly.
- Theme stays synced via `useNeoMuiTheme`.
- API errors, including 401, are handled explicitly.
- Contract types and normalizers remain aligned with backend responses.
- `just build-front` passes.

## Tiny examples
```ts
if (isUnauthorizedError(error)) {
  window.location.assign('/login');
  return;
}
```

## Self-check
- Inspect diff for endpoint/method/path changes in `services/api/*`.
- Verify request and response shape transforms stayed compatible.
- Verify loading/empty/error states and disabled-in-flight behavior.
- Check keyboard access and focus trapping for dialogs/drawers.
- Confirm mobile/tablet/desktop layout still works for touched route.

## Assumptions
- React features are embedded as custom elements and mounted from Elm pages in this repo.
