---
name: frontend-elm-react-interop
description: Add or update Elm-to-React integration via custom elements, interop.ts wiring, and generated Bindings without breaking existing hybrid architecture.
---

# Frontend Elm-React Interop

## Short description (for triggering)
Use when a feature touches both Elm pages and React custom elements (`node "tag"` in Elm plus `customElements.define` in TS).

## When to use / When NOT to use
- Use: New React widget/page rendered inside Elm.
- Use: Wiring changes in `wdintel-web/src/interop.ts`.
- Use: Changes needing new shared backend types for Elm and TS.
- Do not use: Elm-only or React-only isolated work.

## Inputs the agent should request or derive
- Derive desired custom element tag name.
- Derive target Elm page module where `node "<tag>"` should render.
- Derive whether new generated types are needed from backend.
- Ask only if mount location is ambiguous.

## Procedure (checklist)
- Create/update React element file `wdintel-web/src/ts/react/*-element.tsx`:
- Define custom element once with `customElements.get(...)` guard.
- Use `createRoot` + unmount on disconnect.
- Wrap with `ThemeProvider` and `useNeoMuiTheme`.
- Ensure element import is added in `wdintel-web/src/interop.ts`.
- Render it from Elm page via `Html.node "<tag>" [] []`.
- If backend shape changes:
- Add/update type in `wdintel-rs/src/elm.rs`.
- Run `just gen-front`.
- Never hand-write generated frontend backend types.
- Verify compile/build:
- Elm file check with `elm make ... --output=/dev/null`.
- `just build-front`.

## Definition of Done (checklist)
- Custom element is registered and mounted exactly once.
- Elm page renders the correct custom element tag.
- `interop.ts` imports are present.
- Generated bindings are used (no manual type duplication).
- Frontend build passes.

## Tiny examples
```elm
div [] [ node "settings-neo" [] [] ]
```

```ts
if (!customElements.get('settings-neo')) {
  customElements.define('settings-neo', SettingsNeoElement);
}
```

## Self-check
- Confirm tag names match in all three places: TS define, `interop.ts` import, Elm `node`.
- Confirm no duplicate registration risk.
- Confirm API contract impact was assessed if shared types changed.
- Confirm UX states and keyboard behavior still function in embedded context.

## Assumptions
- Hybrid architecture (Elm shell + React custom elements) remains the preferred migration path.
