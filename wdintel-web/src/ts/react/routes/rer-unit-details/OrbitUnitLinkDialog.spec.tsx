/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrbitUnitLinkCandidate } from '../../../../Bindings';
import { getOrbitUnitLinkCandidates, searchOrbitUnits } from '../../services/api/units';
import { OrbitUnitImportDialog, OrbitUnitLinkDialog } from './OrbitUnitLinkDialog';

vi.mock('material-react-table', () => ({
  MaterialReactTable: () => <div data-testid="orbit-candidates-table" />,
  useMaterialReactTable: (options: unknown) => options,
}));

vi.mock('../../components/mui-customized/table/table-state-provider', () => ({
  TableStateProvider: ({ children }: { children: ReactNode }) => children,
  useTableStateContext: () => ({
    enableColumnOrdering: false,
    enableColumnResizing: false,
    columnFilters: [],
    sorting: [],
    columnOrder: [],
    columnSizing: {},
    columnVisibility: {},
    onColumnVisibilityChange: vi.fn(),
    onColumnFiltersChange: vi.fn(),
    onColumnOrderChange: vi.fn(),
    onColumnSizingChange: vi.fn(),
    onSortingChange: vi.fn(),
    onTableInitialized: vi.fn(),
  }),
}));

vi.mock('../../services/api/units', () => ({
  getOrbitUnitLinkCandidates: vi.fn(),
  importOrbitUnit: vi.fn(),
  linkOrbitUnit: vi.fn(),
  searchOrbitUnits: vi.fn(),
}));

const candidate: OrbitUnitLinkCandidate = {
  unitId: 'orbit-unit-id',
  fullName: 'Повна назва',
  generativeUnitNameFull: 'Приналежність',
  operationalUnitNameFull: 'Підпорядкування',
};

async function renderDialog(candidates: OrbitUnitLinkCandidate[]): Promise<Root> {
  vi.mocked(getOrbitUnitLinkCandidates).mockResolvedValueOnce(candidates);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<OrbitUnitLinkDialog unitId={7} onClose={vi.fn()} onLinked={vi.fn()} />);
  });
  return root;
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe('OrbitUnitLinkDialog', () => {
  it('offers advanced search after showing automatic candidates', async () => {
    const root = await renderDialog([candidate]);

    expect(getOrbitUnitLinkCandidates).toHaveBeenCalledWith(
      { unitId: 7, search: null },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(document.body.textContent).toContain(
      'Якщо жоден варіант не підійшов - спробуйте розширений пошук',
    );

    const advancedSearchButton = findButton('Розширений пошук');
    expect(advancedSearchButton).toBeDefined();
    act(() => advancedSearchButton?.click());

    expect(document.body.querySelector('input[placeholder^="Повна назва"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it('opens advanced search immediately when automatic candidates are empty', async () => {
    const root = await renderDialog([]);

    expect(document.body.querySelector('input[placeholder^="Повна назва"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Введіть слова для пошуку підрозділу.');
    expect(findButton('Розширений пошук')).toBeUndefined();

    act(() => root.unmount());
  });

  it('opens Orbit import directly in the shared search form', async () => {
    vi.mocked(searchOrbitUnits).mockResolvedValue([]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<OrbitUnitImportDialog onClose={vi.fn()} onImported={vi.fn()} />);
    });

    expect(document.body.textContent).toContain('Пошук');
    expect(document.body.querySelector('input[placeholder^="Повна назва"]')).not.toBeNull();
    expect(getOrbitUnitLinkCandidates).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
