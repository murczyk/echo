# Units

## Unit API response normalization

- **Status:** operational compatibility

- **Behavior ID:** `react-units-api-response-normalization`
- **Affected route/component:** shared unit API service and Unit forms.
- **User role or permission:** users permitted to inspect, create, update, or attach files to units.
- **Preconditions:** a unit list/page, duplicate check, detail, attachment action, or ORBIT request returns a supported wire response.
- **User action or external event:** a user loads unit data, checks duplicates, searches/imports ORBIT data, or changes an attachment.
- **Expected observable result:** unit lists, duplicate candidates, ORBIT search/imports, attachment/update/upload values, visible attachment IDs, device-network results, pagination metadata, and nullable legacy AOR fields normalize for React consumers.
- **Loading/empty/error/success behavior:** empty optional collections and nullable legacy fields remain usable rather than causing malformed UI state.
- **URL, localStorage, or user-settings persistence:** none at this API boundary.
- **API endpoint and compatibility requirements:** unit, attachment, ORBIT candidate, pagination, and device-network responses support snake-case normalization and legacy optional fields.
- **Responsive and keyboard requirements:** none at this API boundary.
- **Known race/idempotency constraints:** none at the response-normalization boundary.
- **Source implementation:** `src/ts/react/services/api/units.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/services/api/__tests__/units.spec.ts`, `wdintel-web/src/ts/react/routes/rer-units-neo/components/__tests__/UnitFormDrawer.spec.tsx`
- **Original Echo issue/PR, if known:** none recorded; retained as operational parser coverage.

## Unit request, search, and pagination compatibility

- **Status:** operational compatibility
- **Behavior ID:** `react-units-request-search-pagination-compatibility`
- **Affected route/component:** shared unit API service, Unit forms, and unit search controls.
- **User role or permission:** users permitted to inspect, create, update, or attach files to units.
- **Preconditions:** a unit search, page load, CRUD request, or attachment upload is initiated.
- **User action or external event:** a user searches, selects inactive units, loads additional pages, creates/updates a unit, or uploads an attachment.
- **Expected observable result:** strict search runs before relaxed search, unit IDs deduplicate, inactive-unit selection and complete cursor paging preserve their intent, and CRUD/multipart operations retain their established routes and request keys.
- **Loading/empty/error/success behavior:** empty pages end cursor traversal without losing prior rows; request failures continue through the existing caller error handling.
- **URL, localStorage, or user-settings persistence:** none at this API boundary.
- **API endpoint and compatibility requirements:** strict/relaxed search ordering, request keys, CRUD routing, and multipart upload fields remain compatible with the backend.
- **Responsive and keyboard requirements:** none at this API boundary.
- **Known race/idempotency constraints:** duplicate checks must be evaluated against current server candidates before an irreversible create action.
- **Source implementation:** `src/ts/react/services/api/units.ts`
- **Existing test(s):** No direct default-suite test; behavior is preserved by this contract.
- **Original Echo issue/PR, if known:** none recorded.

## ORBIT presence and duplicate selection

- **Status:** normative
- **Behavior ID:** `react-units-orbit-presence-and-duplicate-selection`
- **Affected route/component:** RER Unit form drawer.
- **Expected observable result:** a unit can be absent from ORBIT, present but unlinked, or linked to an ORBIT record. Creating an ORBIT-linked unit waits for the operator to explicitly select an offered duplicate association, so the resulting unit retains that relationship.
- **Source implementation:** `src/ts/react/routes/rer-units-neo/components/UnitFormDrawer.tsx`.
