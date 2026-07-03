---
name: frontend-react-mui-implementation
description: Implement or refactor React + MUI features in wdintel-web/src/ts/react using custom-element entrypoints, useNeoMuiTheme, Power* MUI wrappers, route hook splitting, user-settings hooks, and typed API service patterns.
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
- Derive accepted route split from nearby `use-*-page.*` / `helpers*` files before adding new modules.
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
- Prefer the shared auth redirect helper in `src/ts/react/auth-redirect.ts` over route-local login redirects when the page already uses the shared auth flow.
- Keep UI errors visible via `PowerAlert` (or the established UI messaging pattern on the page).
- Prefer existing styling mix:
- MUI `sx` for component-level styles.
- Existing utility classes (`className`) where already used.
- Use modern React imports consistently:
- Do not keep a default `React` import just for JSX.
- Import hooks and runtime helpers directly from `react` (for example `useState`, `useEffect`, `memo`, `forwardRef`, `createElement`, `Fragment`).
- Import React-only types via `import type` (for example `ReactNode`, `ChangeEvent`, `MouseEvent`, `ComponentProps`, `PropsWithChildren`).
- Prefer `ReactNode` over `React.ReactNode` and avoid `React.*` namespace access when a direct import is available.
- If you touch a React file and see mixed import styles, normalize that file to the direct-import style as part of the change.
- Keep functions focused; split large handlers/helpers.
- Keep files small: prefer 200-300 lines, and treat 500 lines as a hard cap that should trigger a split before merging.
- For large neo route pages/hooks, follow the accepted split:
- `index.tsx`: page composition and presentational wiring.
- `use-*-page.ts`: orchestration, memoized derived values, lazy-load triggers, returned view model.
- `use-*-page.shared.ts`: types, constants, pure format/permission helpers, empty state.
- `use-*-page.load.ts`: initial/reference/lazy API loading with abort or generation guards.
- `use-*-page.actions.ts` plus focused `*.actions.ts`: mutations, drawers/dialogs, in-flight/error state.
- `helpers*.ts`: pure row/form/filter/search mapping with colocated specs.
- Keep pure helpers outside components/hooks when they can be unit-tested.
- Prefer shared custom-element mount helpers or route entry wrappers over duplicating mount boilerplate when a reusable helper already exists.
- In async effects, use `AbortController` for request cancellation or a generation ref for stale route/page reloads; never set state after abort/stale generation.
- Load independent reference data with `Promise.all`; keep noncritical follow-up loads from blocking primary page readiness.
- Use central nullish helpers from `utils/misc.ts` (`isNullOrUndefined`, `isPresent`, `isNullish`) instead of manual `value === null || value === undefined` checks.
- For cross-page user preferences, prefer typed hooks and `services/api/user-settings.ts` normalizers/serializers over component-local API calls.
- When settings must update multiple mounted surfaces, dispatch/listen to the existing settings update event instead of relying on page reloads.
- For save-on-change settings, queue saves with refs so rapid toggles coalesce and later values are not lost.
- Prefer shared controls for repeated UX:
- `SavedFiltersControl` for saved filter CRUD.
- `PageHeader` and existing top-action styles for neo page headers/actions.
- **Power wrappers** (`wdintel-web/src/ts/react/components/`): prefer these over raw MUI when the use case matches.
  | MUI | Use instead |
  | --- | --- |
  | `Alert` | `PowerAlert` — auto-hide, dismissible severity alerts (errors/warnings/info/success) |
  | `Button` | `PowerButton` — debounced double-submit guard |
  | `IconButton` | `PowerIconButton` |
  | `Chip` (selectable/filter tags) | `PowerChip` or `CompactPowerChip` |
  | `Menu` | `PowerMenu` — Escape does not bubble to parent drawers |
  | Raw MUI is OK when no wrapper exists, props differ materially, or the file already uses raw MUI consistently and you are not touching that UI.
- Avoid MUI `Menu` for hover-only popups when it can focus or `aria-hide` surrounding content; prefer non-modal `Popper`/`Tooltip`-style patterns there.
- For React pages that need date selection, prefer MUI X `DatePicker` / `DateTimePicker` with the app locale/theme conventions.
- Do not use native `input type="date"` / `datetime-local` unless there is a documented repo-specific reason.
- Reuse the existing date-picker patterns in `DateTimeRangeControl.tsx` and `NetworkFreqDatePickerField.tsx` instead of adding ad hoc native inputs.
- Run frontend verification:
- Format touched frontend files before final verification:
- `cd wdintel-web && npm run format:staged`
- Use `npm run format:all` only for intentional whole-tree formatting.
- `just build-front`
- Run targeted TS tests if touched:
- `cd wdintel-web && npm run test:ts`

## Definition of Done (checklist)
- Custom element still mounts/unmounts correctly.
- Theme stays synced via `useNeoMuiTheme`.
- API errors, including 401, are handled explicitly.
- Contract types and normalizers remain aligned with backend responses.
- Route files stay split by responsibility when page logic grows.
- Shared user settings are normalized, persisted, and broadcast consistently.
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
- New or touched neo UI uses `Power*` wrappers where a matching one exists (especially `PowerAlert` for page/drawer errors).
- Check touched React files for stray default `React` imports, duplicate `react` imports, or leftover `React.*` namespace usage.
- Confirm Prettier formatting was applied with `cd wdintel-web && npm run format:staged` after TS/TSX/JS/CSS/JSON/Markdown edits.
- Check new hook/component modules have focused names and matching targeted tests for pure helpers or state-heavy behavior.
- Check keyboard access and focus trapping for dialogs/drawers.
- Check public URL tab values against internal ids; keep aliases only for intentional legacy compatibility.
- Confirm mobile/tablet/desktop layout still works for touched route.

## Assumptions
- React features are embedded as custom elements and mounted from Elm pages in this repo.
