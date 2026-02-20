---
name: frontend-elm-implementation
description: Implement or refactor Elm pages/components in wdintel-web using existing Page/Effect patterns, generated Bindings, and repo error-handling rules.
---

# Frontend Elm Implementation

## Short description (for triggering)
Use when editing Elm in `wdintel-web/src` (pages, shared components, TEA update/view flows, API responses).

## When to use / When NOT to use
- Use: Elm page/component logic, view changes, API response handling in Elm.
- Use: Changes touching `Pages.*`, `Pages_.*`, `Shared.*`, `Utils.Api.ErrorHandling`.
- Do not use: React TSX changes (`wdintel-web/src/ts/react`).
- Do not use: Pure commit/changelog tasks.

## Inputs the agent should request or derive
- Derive target Elm modules from changed routes/components.
- Derive existing pattern from nearby files in same feature folder.
- Derive whether backend type changes are needed.
- Ask only if route/feature target is ambiguous.

## Procedure (checklist)
- Match existing module structure:
- `Page.new` + `Page.withLayout` for page modules.
- Keep small functions; split large `update`/view helpers.
- Follow naming in feature files; avoid introducing parallel style.
- For backend types:
- Never hand-write backend decoders/types in Elm.
- If new backend type is needed, update `wdintel-rs/src/elm.rs` and run `just gen-front`.
- Handle API errors with:
- `Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "..." err`
- Do not silently ignore failures.
- Preserve 401 behavior (logout) by using the shared formatter.
- Run fast local check for edited Elm files:
- `cd wdintel-web && elm make <edited-file>.elm --output=/dev/null`
- Run final frontend build:
- `just build-front`

## Definition of Done (checklist)
- Elm code compiles for edited files.
- `just build-front` passes.
- API errors are shown to user via shared formatter.
- No manual edits to generated `wdintel-web/src/Bindings.elm`.
- Behavior matches existing page/layout patterns.

## Tiny examples
```elm
SomeApiResponse (Err err) ->
    ( model
    , Utils.Api.ErrorHandling.formatErrorForShowErrorWithDetails "Помилка завантаження" err
    )
```

## Self-check
- Review diff for accidental `Bindings.elm` manual edits or unrelated formatting.
- Confirm API paths/payload expectations used by Elm effects did not change silently.
- Confirm loading/empty/error states still render after update.
- Confirm keyboard/focus flow for any added controls.
- Confirm repo checks were run (`elm make` on touched module, `just build-front`).

## Assumptions
- Elm app follows Elm Land + TEA conventions already present in `wdintel-web/src/Pages*`.
