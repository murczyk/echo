/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrbitUnitLinkCandidate, Unit } from '../../../../Bindings';
import { getOrbitUnitLinkCandidates, searchOrbitUnits } from '../../services/api/units';
import {
  OrbitUnitImportDialog,
  OrbitUnitLinkDialog,
  OrbitUnitPickerDialog,
} from './OrbitUnitLinkDialog';

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

const sigintUnit: Unit = {
  id: 7,
  other: '',
  teamOrCrew: '',
  section: '',
  squad: '',
  platoon: '',
  company: '1 рота',
  battalion: '2 батальйон',
  regiment: '3 бригада',
  brigade: '',
  division: '',
  corps: '',
  army: '',
  militaryDistrict: '',
  armyRegion: '',
  comment: '',
  orbitNote: null,
  presentInOrbit: null,
  name: '1 рота 2 батальйон 3 бригада',
  active: true,
  isDeduplicateCandidate: null,
  createdAt: 0,
  createdByLoginId: '',
  hasOrbit: false,
  orbitUnitIds: [],
  orbitUnitGenerativeNames: [],
};

async function renderDialog(
  candidates: OrbitUnitLinkCandidate[],
  unit: Unit = sigintUnit,
): Promise<Root> {
  vi.mocked(getOrbitUnitLinkCandidates).mockResolvedValueOnce(candidates);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <OrbitUnitLinkDialog unitId={7} unit={unit} onClose={vi.fn()} onLinked={vi.fn()} />,
    );
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
  it('omits a hierarchy that repeats the unit value from the name', async () => {
    const root = await renderDialog([candidate], {
      ...sigintUnit,
      company: '',
      battalion: '',
      regiment: '1196 МСП',
      division: '45 дшд',
      army: '34 ЗВА',
      militaryDistrict: 'ОУВ(с)',
      name: '1196 МСП 49 ЗА',
    });

    expect(document.body.textContent).toContain("Прив'язати Orbit підрозділ 1196 МСП 49 ЗА");
    expect(document.body.textContent).not.toContain('(1196 МСП 45 дшд 34 ЗВА ОУВ(с))');
    expect(document.body.textContent).not.toContain('Підрозділ SIGINT');

    act(() => root.unmount());
  });

  it('keeps hierarchy context for a distinct unit name', async () => {
    const root = await renderDialog([candidate], { ...sigintUnit, name: 'Окрема назва' });

    expect(document.body.textContent).toContain(
      "Прив'язати Orbit підрозділ Окрема назва (1 рота 2 батальйон 3 бригада)",
    );

    act(() => root.unmount());
  });

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

  it('reuses the shared advanced search dialog for Orbit selection', async () => {
    const searchUnits = vi.fn().mockResolvedValue([]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <OrbitUnitPickerDialog
          title="Оберіть підрозділ ORBIT"
          searchUnits={searchUnits}
          onClose={vi.fn()}
          onSelected={vi.fn()}
        />,
      );
    });

    expect(document.body.textContent).toContain('Оберіть підрозділ ORBIT');
    expect(document.body.querySelector('input[placeholder^="Повна назва"]')).not.toBeNull();
    expect(getOrbitUnitLinkCandidates).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
