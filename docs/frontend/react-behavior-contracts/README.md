# React behavior contracts

This index preserves intentional React behavior independently of individual Vitest or Playwright tests. It supplements, rather than duplicates, [the layout contract](../layout-component-contract.md), [Duty documentation](../../duty/README.md), and [React component documentation](../../../wdintel-web/src/ts/react/components/README.md).

Each entry identifies its production boundary, observable outcome, persistence rules, API compatibility, and the admitted regression or safeguard that protects it. A test can be removed only after its behavior is represented here, in production configuration/types, or at a stronger admitted boundary.

## Current contracts

- [Admin pages](admin-pages.md): GOI drawer lifecycle and worker setup.
- [API and error handling](api-and-error-handling.md): unauthorized redirects and error fallback handling.
- [Analysis](analysis.md): analysis request and message API compatibility.
- [Callsigns](callsigns.md): legacy and current quick-paste TSV compatibility.
- [Navigation and URL state](navigation-and-url-state.md): Battle Line and Device Analytics tabs.
- [Devices](devices.md): file-registry error classification and tag actions.
- [Duty](duty.md): keyword-set selection and API compatibility.
- [Document previews](document-previews.md): document parsing, limits, and sanitization.
- [Image editor](image-editor.md): image-editing geometry, export, history, and replacement safety.
- [MRT tables](mrt-tables.md): internal column order, persisted table state, and overflow actions.
- [Message card and inbox compatibility](message-card.md): message wire normalization.
- [Networks](networks.md): network report, frequency, and callsign API compatibility.
- [Settings](settings.md): Settings presentation and persisted-preference safeguards.
- [Shared components and browser boundaries](shared-components.md): clipboard fallback safety.
- [Units](units.md): unit search, duplicates, attachment, and ORBIT API compatibility.
- [Maps and coordinates](maps.md): coordinate interchange and locality labels.

## Migration status

All current React tests remain subject to the admission gate: they must carry a
truthful parser, concrete safeguard, or Echo issue/PR regression annotation.
`npm run test:ts` remains the complete migration suite; newly introduced
test-only production exports are also rejected relative to the PR merge base.

## Entry template

```text
Behavior ID:
Status: normative | issue-backed regression | operational compatibility | inferred characterization | unresolved
Affected route/component:
User role or permission:
Preconditions:
User action or external event:
Expected observable result:
Loading/empty/error/success behavior:
URL, localStorage, or user-settings persistence:
API endpoint and compatibility requirements:
Responsive and keyboard requirements:
Known race/idempotency constraints:
Source implementation:
Existing test(s):
Original Echo issue/PR, if known:
```
