# Units

## Unit API compatibility

- **Status:** operational compatibility

- **Behavior ID:** `react-units-api-compatibility`
- **Affected route/component:** shared unit API service, Unit forms, and unit search controls
- **User role or permission:** users permitted to inspect, create, update, or attach files to units
- **Preconditions:** a unit list, search, duplicate check, attachment action, or ORBIT import is requested
- **User action or external event:** a user searches, pages through, creates, edits, links, imports, uploads, or removes a unit attachment
- **Expected observable result:** strict matches precede deduplicated relaxed matches; active/inactive paging and counts remain accurate; duplicate candidates arrive before unit creation; attachment and imported-unit responses normalize for the editor.
- **Loading/empty/error/success behavior:** absent optional result collections become usable empty collections; explicit inactive requests and bounded paging retain their intended server-side filters.
- **URL, localStorage, or user-settings persistence:** none at this API boundary.
- **API endpoint and compatibility requirements:** request payloads use the established wire keys; unit, attachment, ORBIT candidate, and count responses support snake-case normalization and legacy optional fields.
- **Responsive and keyboard requirements:** none at this API boundary.
- **Known race/idempotency constraints:** duplicate checks must be evaluated against the current server candidates before an irreversible create action.
- **Source implementation:** `src/ts/react/services/api/units.ts`
- **Existing test(s):** `src/ts/react/services/api/__tests__/units.spec.ts`, `routes/rer-units-neo/components/UnitFormDrawer.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as operational parser and compatibility coverage.

## ORBIT presence and duplicate selection

- **Status:** normative
- **Behavior ID:** `react-units-orbit-presence-and-duplicate-selection`
- **Affected route/component:** RER Unit form drawer.
- **Expected observable result:** a unit can be absent from ORBIT, present but unlinked, or linked to an ORBIT record. Creating an ORBIT-linked unit waits for the operator to explicitly select an offered duplicate association, so the resulting unit retains that relationship.
- **Source implementation:** `src/ts/react/routes/rer-units-neo/components/UnitFormDrawer.tsx`.
