# React test packing exceptions

The final React test tree uses the nearest matching `__tests__/` directory.
Only an occupied one-to-one destination permits a source test to remain outside
that directory. These exceptions are not admission debt.

## Occupied destinations

- `src/ts/react/hooks/use-duty-settings.spec.tsx`
- `src/ts/react/routes/rer-analysis-neo/use-analysis-message-editor.spec.ts`
- `src/ts/react/routes/rer-units-neo/helpers.spec.ts`
- `src/ts/react/services/api/ai-agent.spec.ts`
- `src/ts/react/services/api/palitra.spec.ts`

Before a future relocation, compare resolved relative production imports and
`vi.mock()` targets before and after the move, then run the moved suite and its
leaf-directory cohort. If module cache, hoisted mocks, global state, fixture
paths, or ordering makes relocation unsafe, record the concrete evidence here.
