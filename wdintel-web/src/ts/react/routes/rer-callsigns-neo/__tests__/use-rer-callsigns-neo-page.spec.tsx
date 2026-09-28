/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Callsign, Source, Unit, User } from '../../../../../Bindings';
import { useRerCallsignsNeoPage } from '../use-rer-callsigns-neo-page';

const loadMockState = vi.hoisted(() => ({
  loaded: false,
}));

vi.mock('../use-rer-callsigns-neo-page.load', () => ({
  useRerCallsignsNeoPageLoad: ({
    setUser,
    setUnits,
    setSources,
    setCallsigns,
    setLoading,
    setAddSourceId,
  }: {
    setUser: (user: User | null) => void;
    setUnits: (units: Unit[]) => void;
    setSources: (sources: Source[]) => void;
    setCallsigns: (callsigns: Callsign[]) => void;
    setLoading: (loading: boolean) => void;
    setAddSourceId: (sourceId: number | null) => void;
  }) => {
    if (!loadMockState.loaded) {
      loadMockState.loaded = true;
      setUser({ roles: ['Rer', 'CallsignsEditor'] } as User);
      setUnits([
        { id: 1, name: '11 АК', active: true } as Unit,
        { id: 2, name: ' 11 АК ', active: true } as Unit,
        { id: 3, name: '', active: true } as Unit,
      ]);
      setSources([{ id: 1, name: 'РО' } as Source]);
      setCallsigns([
        {
          id: 10,
          callsign: 'ЛЕСНОЙ',
          position: 'Командир',
          fullName: 'Іваненко Іван Іванович',
          comment: '',
          unitId: 1,
          sourceId: 1,
          callsignAdditionalSources: [],
          developing: false,
          radioFreq: null,
          createdAt: 0,
          active: true,
        } as Callsign,
      ]);
      setAddSourceId(1);
      setLoading(false);
    }

    return {
      runListFetch: vi.fn(),
      refreshLookupsAndStats: vi.fn(),
    };
  },
}));

type Page = ReturnType<typeof useRerCallsignsNeoPage>;

const rendered: Root[] = [];
let latestPage: Page | null = null;

function HookHarness() {
  latestPage = useRerCallsignsNeoPage({ authUserRoles: ['Rer', 'CallsignsEditor'] });
  return null;
}

function renderHookHarness(): Page {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  rendered.push(root);

  act(() => {
    root.render(createElement(HookHarness));
  });

  if (!latestPage) throw new Error('Hook did not render');
  return latestPage;
}

afterEach(() => {
  for (const root of rendered.splice(0)) {
    act(() => root.unmount());
  }
  latestPage = null;
  loadMockState.loaded = false;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});
describe('useRerCallsignsNeoPage duplicate hints', () => {
  it('exposes selectable units without blank-name entries', () => {
    const page = renderHookHarness();

    expect(page.selectableUnits).toEqual([
      { id: 1, name: '11 АК', active: true },
      { id: 2, name: '11 АК', active: true },
    ]);
  });

  it('calculates duplicate hints immediately after quick paste', () => {
    const page = renderHookHarness();

    act(() => {
      page.setAddUnitId(1);
    });

    act(() => {
      latestPage?.onApplyPastedRows('ЛЕСНОЙ\tНачальник\tІваненко Іван Іванович\tновий коментар');
    });

    expect(latestPage?.addPotentialDuplicateGroups).toEqual([
      {
        rowIndex: 0,
        matches: [
          {
            id: 10,
            callsign: 'ЛЕСНОЙ',
            position: 'Командир',
            fullName: 'Іваненко Іван Іванович',
            comment: '',
            unitName: '11 АК',
          },
        ],
      },
    ]);
  });

  it('keeps regular typing duplicate hints working', () => {
    const page = renderHookHarness();

    act(() => {
      page.setAddUnitId(1);
    });

    act(() => {
      latestPage?.onRowChange(0, {
        callsign: 'ЛЕСНОЙ',
        position: 'Командир',
        fullName: '',
        comment: '',
        developing: false,
        radioFreq: '',
      });
    });

    expect(latestPage?.addPotentialDuplicateGroups).toEqual([
      {
        rowIndex: 0,
        matches: [
          {
            id: 10,
            callsign: 'ЛЕСНОЙ',
            position: 'Командир',
            fullName: 'Іваненко Іван Іванович',
            comment: '',
            unitName: '11 АК',
          },
        ],
      },
    ]);
  });
});

describe('useRerCallsignsNeoPage unit filters', () => {
  // Regression: https://github.com/echoua/echo/issues/3387
  it('keeps the selected hierarchy while filtering the unit column for echo-3387', () => {
    const page = renderHookHarness();
    const hierarchyFilter = {
      kind: 'group' as const,
      label: '15 тп',
      hierarchy: {
        armyRegion: null,
        militaryDistrict: 'ЛВО',
        army: '6 А',
        division: '69 мсд',
        regiment: '15 тп',
        battalion: null,
      },
    };

    act(() => {
      page.onPickUnitFilter(hierarchyFilter);
    });
    act(() => {
      latestPage?.onFiltersChange((prev) => ({ ...prev, filterUnit: 'мсб' }));
    });

    expect(latestPage?.selectedSidebarUnitFilter).toEqual(hierarchyFilter);
    expect(latestPage?.filters.filterUnit).toBe('мсб');

    act(() => {
      latestPage?.onClearUnitFilter();
    });

    expect(latestPage?.selectedSidebarUnitFilter).toBeNull();
    expect(latestPage?.filters.filterUnit).toBe('мсб');
  });
});
