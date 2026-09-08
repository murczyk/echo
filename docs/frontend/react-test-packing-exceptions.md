# React test packing exceptions

The React test migration moves one file only to its nearest matching
`__tests__/` directory. A source test remains in place when that exact target
already contains an independently maintained test file: merging, flattening,
or renaming suites would change test identity and ownership rather than simply
pack the file.

## Existing destination collision

The following audited source files have an occupied one-to-one destination.
They remain in their current location under the mixed layout. These are
packing exceptions, not unreviewed or newly admitted test debt.

- `src/ts/react/hooks/use-duty-settings.spec.tsx`
- `src/ts/react/routes/rer-analysis-neo/use-analysis-message-editor.spec.ts`
- `src/ts/react/routes/rer-callsigns-neo/helpers.spec.ts`
- `src/ts/react/routes/rer-network-details-neo/use-rer-network-details-neo-page.callsign-actions.spec.tsx`
- `src/ts/react/routes/rer-units-neo/helpers.spec.ts`
- `src/ts/react/routes/settings-neo/index.spec.tsx`
- `src/ts/react/routes/settings-neo/SettingsMyReportsSection.spec.tsx`
- `src/ts/react/services/api/ai-agent.spec.ts`
- `src/ts/react/services/api/palitra.spec.ts`

Before any future relocation, compare every relative production import and
`vi.mock()` target as resolved paths before and after the move. Run the moved
spec and its leaf-directory cohort. If relocation alone changes module-cache,
hoisted-mock, global-state, fixture-path, or order-dependent behavior, restore
the original path and add the resulting evidence here.

## Verified one-to-one relocations

- 2026-09-02 — Analysis Neo component leaf: `AnalysisCallsignFrequencySearch`,
  `AnalysisCorrelatedFreqsCard`, and `AnalysisGroupsActivityCard` retained the
  same resolved production imports and `vi.mock()` targets at their
  `components/__tests__/` destinations. The three moved specs passed (7 tests),
  and the complete component cohort passed after the accompanying audit
  removals (14 files, 184 tests).

- 2026-09-02 — Analysis Neo component leaf: `AnalysisCallsignGraphPane`,
  `AnalysisCountBlock`, `AnalysisFilterField`, `AnalysisFiltersPanel`,
  `AnalysisHeaderControls`, `AnalysisMapPane`, `AnalysisMessagesPane`,
  `AnalysisPaginationControl`, `AnalysisReportDialog`, and `AnalysisSidebar`
  retained identical resolved imports and mock targets at their one-to-one
  destinations. Their moved-spec and cohort runs passed; the required serial
  checkpoint passed 383 files and 3,051 tests. `AnalysisSummaryTableCard`
  remains the documented exception above.

- 2026-09-02 — Analysis Neo root leaf: `AnalysisPageHeader` and the page
  integration `index` spec retained identical resolved imports and mock
  targets at their one-to-one destinations. Their focused run passed, and the
  full Analysis Neo cohort passed 43 files and 477 tests.
