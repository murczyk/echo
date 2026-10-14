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
- **Expected observable result:** a unit can be absent from ORBIT, present but unlinked, or linked to an ORBIT record. For `UnitsEditor`, creating an ORBIT-linked unit waits for the operator to explicitly select an offered duplicate association, so the resulting unit retains that relationship. Message writers without `UnitsEditor` can create full units but cannot select or submit destructive duplicate merges.
- **Source implementation:** `src/ts/react/routes/rer-units-neo/components/UnitFormDrawer.tsx`.

## Unlinked-unit reconciliation

- **Status:** normative
- **Affected route/component:** `/admin/units`, default tab `unlinked` («Відсутні в Orbit»).
- **Expected observable result:** all non-deleted units without an active Orbit link, including inactive units, are searchable and paginated using seek boundaries with a deterministic ID tie-breaker (name and ID by default), without growing offsets. Previous-page navigation reuses saved cursors; changing filters or sorting starts at the first page. Editors can link Orbit units and merge duplicates. Completion refreshes the current page and counts, clamping an emptied last page; attachment-metadata failures do not retain removed rows. Settings and list failures provide retry actions. Query filters survive reload and tab selection follows browser history.
- **Existing test(s):** `wdintel-web/tests/e2e/admin-units-unlinked.spec.ts`, `wdintel-web/src/ts/react/routes/rer-units-neo/__tests__/use-rer-units-page.spec.tsx`, `wdintel-web/tests/e2e/manage-message-unit.regression.spec.ts`.
- **Original Echo issue/PR:** [#3535](https://github.com/echoua/echo/issues/3535).

## SIGINT combat types

- **Status:** normative
- **Behavior ID:** `react-units-combat-type`
- **Affected route/component:** `/rer-units-neo`, `/rer-units/{id}`, shared `UnitFormDrawer`.
- **Expected observable result:** the default-visible «Види та роди ЗС» column follows «Регіон/ТВД/Збройні Сили» and displays the retained SIGINT dictionary name. Text filtering and ascending/descending sorting use that name. Both editing routes assign, change, and clear the nullable dictionary reference; unassigned units display an empty table value.
- **Loading/empty/error/success behavior:** selectors wait for dictionary loading, display load failures, retain existing assignments, and offer «Не визначено» to clear them. Unit writes retain existing authorization and error handling.
- **API endpoint and compatibility requirements:** `/api/sigint/unit/combat-types` returns the copied dictionary; omission of `combat_type_id` preserves an assignment and explicit null clears it. ORBIT sync only inserts missing dictionary entries; it does not overwrite local names or unit assignments.
- **Source implementation:** `wdintel-web/src/ts/react/routes/rer-units-neo/components/UnitsTable.tsx`, `wdintel-web/src/ts/react/routes/rer-units-neo/components/UnitFormDrawer.tsx`, `wdintel-web/src/Pages/RerUnits/Id_.elm`.
- **Existing test(s):** `wdintel-web/tests/e2e/units-combat-type.spec.ts`, `wdintel-web/src/ts/react/routes/rer-units-neo/__tests__/index.spec.tsx`, `wdintel-rs/src/sigint/unit/combat_type.rs`, `wdintel-rs/src/orbit/combat_type.rs`.
- **Original Echo issue/PR:** [#3113](https://github.com/echoua/echo/issues/3113).
