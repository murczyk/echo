# Callsigns

## Unit statistics hierarchy

- **Status:** inferred characterization
- **Behavior ID:** `callsigns-unit-stats-hierarchy`
- **Affected route/component:** Callsigns unit-stat sidebar
- **Expected observable result:** unavailable unit IDs are excluded before hierarchy rendering. Empty hierarchy levels are skipped; the supported echelon order is army region, military district, army, corps, division, brigade, regiment, battalion, company, platoon, squad, section, team/crew, and other; terminal singleton paths collapse into the unit leaf. Identical labels remain separated by their full hierarchy path.
- **Source implementation:** `wdintel-web/src/ts/react/routes/rer-callsigns-neo/helpers-rows.ts`, `wdintel-web/src/ts/react/routes/rer-callsigns-neo/components/UnitStatsSidebar.tsx`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-callsigns-neo/__tests__/helpers.spec.ts`, `wdintel-web/src/ts/react/routes/rer-callsigns-neo/components/__tests__/UnitStatsSidebar.spec.ts`

## Quick-paste TSV parsing

- **Status:** operational compatibility

- **Behavior ID:** `react-callsigns-quick-paste-tsv`
- **Affected route/component:** RER Callsigns quick-paste helper
- **User role or permission:** users allowed to create or edit callsigns
- **Preconditions:** the user pastes tab-delimited callsign rows
- **User action or external event:** legacy three-column or current four-column TSV input is parsed
- **Expected observable result:** rows preserve callsign, position, full-name, comment, and trailing-empty-column meaning; mixed valid row shapes parse line-by-line; unsupported or ambiguous flat multi-row shapes return a validation error rather than silently misassigning fields.
- **Loading/empty/error/success behavior:** invalid input remains a validation error and creates no draft rows.
- **URL, localStorage, or user-settings persistence:** none.
- **API endpoint and compatibility requirements:** preserves legacy three-column import compatibility while supporting four-column input.
- **Responsive and keyboard requirements:** paste behavior remains available from the existing keyboard input control.
- **Known race/idempotency constraints:** ambiguous input must not create duplicate or shifted callsign records.
- **Source implementation:** `routes/rer-callsigns-neo/helpers.ts`
- **Existing test(s):** `wdintel-web/src/ts/react/routes/rer-callsigns-neo/__tests__/helpers.spec.ts`
- **Original Echo issue/PR, if known:** none recorded; retained as operational parser coverage.
