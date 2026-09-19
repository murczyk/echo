/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Network, Unit, User } from '../../../../../Bindings';
import {
  getDefaultNetworkPelengDateRange,
  getDefaultNetworkRelationsDateRange,
} from '../use-rer-network-details-neo-page.forms';
import { EMPTY_STATE } from '../use-rer-network-details-neo-page.types';

const loadMockState = vi.hoisted(() => ({
  loaded: false,
  currentUser: { roles: ['Rer'] } as User | null,
  loadNetworkActivity: vi.fn(),
  loadCallsigns: vi.fn(),
  loadRelations: vi.fn(),
  loadPelengPoints: vi.fn(),
}));

const actionMockState = vi.hoisted(() => ({
  loadFrequencies: vi.fn(),
  loadCallsigns: vi.fn(),
  loadNetworkActivity: vi.fn(),
  loadPelengPoints: vi.fn(),
  setActiveNetworkDetailsTab: vi.fn(),
}));

vi.mock('../use-rer-network-details-neo-page.load', () => ({
  useRerNetworkDetailsNeoPageLoad: (
    _networkId: number,
    setState: (updater: (current: typeof EMPTY_STATE) => typeof EMPTY_STATE) => void,
  ) => {
    loadMockState.loadCallsigns.mockImplementation(async () => {
      setState((current) => ({
        ...current,
        networkCallsignsLoaded: true,
        networkCallsignsLoading: false,
        networkCallsignsError: null,
        catalogCallsignsLoaded: true,
        catalogCallsignsLoading: false,
        catalogCallsignsError: null,
        interceptedCallsignsLoaded: true,
        interceptedCallsignsLoading: false,
        interceptedCallsignsError: null,
        callsignsLoaded: true,
        callsignsLoading: false,
        callsignsError: null,
      }));
    });
    loadMockState.loadNetworkActivity.mockImplementation(async () => {
      setState((current) => ({
        ...current,
        networkActivityLoaded: true,
        networkActivityLoading: false,
        networkActivityError: null,
      }));
    });
    loadMockState.loadRelations.mockImplementation(async () => {
      setState((current) => ({
        ...current,
        relationsLoaded: true,
        relationsLoading: false,
        relationsError: null,
      }));
    });
    loadMockState.loadPelengPoints.mockImplementation(
      async (_networkId, sinceDateInclusiveMs, tillDateNoninclusiveMs) => {
        setState((current) => ({
          ...current,
          pelengPointsLoaded: true,
          pelengPointsLoading: false,
          pelengPointsError: null,
          pelengPointsRequestedFrom: sinceDateInclusiveMs,
          pelengPointsRequestedTo: tillDateNoninclusiveMs,
        }));
      },
    );

    if (!loadMockState.loaded) {
      loadMockState.loaded = true;
      const network = {
        id: 42,
        name: 'Мережа 42',
        descriptions: [],
        aorIds: [],
        unitIds: [],
        postIds: [],
        freqs: [],
      } as Network;
      setState((current) => ({
        ...current,
        network,
        units: [
          { id: 1, name: '11 АК', active: true } as Unit,
          { id: 2, name: ' 11 АК ', active: true } as Unit,
          { id: 3, name: '', active: true } as Unit,
        ],
        aors: [
          { id: 2, name: 'Бета' } as never,
          { id: 3, name: 'Вся смуга' } as never,
          { id: 1, name: 'Альфа' } as never,
        ],
        posts: [{ id: 10, name: '   ' } as never, { id: 11, name: 'Пост A' } as never],
        ...getDefaultNetworkRelationsDateRange(new Date('2026-06-20T12:00:00Z')),
        ...getDefaultNetworkPelengDateRange(network, new Date('2026-06-20T12:00:00Z')),
      }));

      void Promise.resolve().then(() => {
        setState((current) => ({
          ...current,
          currentUserLoaded: true,
          currentUser: loadMockState.currentUser,
        }));
      });
    }

    return {
      reload: vi.fn(),
      loadCallsigns: loadMockState.loadCallsigns,
      loadRelations: loadMockState.loadRelations,
      loadNetworkActivity: loadMockState.loadNetworkActivity,
      loadPelengPoints: loadMockState.loadPelengPoints,
    };
  },
}));

vi.mock('../use-rer-network-details-neo-page.actions', () => ({
  useRerNetworkDetailsNeoPageActions: ({
    setState,
  }: {
    setState: (updater: (current: typeof EMPTY_STATE) => typeof EMPTY_STATE) => void;
  }) => {
    actionMockState.loadFrequencies.mockImplementation(async () => {
      setState((current) => ({
        ...current,
        freqs: current.freqs.length > 0 ? current.freqs : [{ networkFreqId: 1 } as never],
        freqActivityByFreq: current.freqActivityByFreq,
        freqsLoaded: true,
        freqsLoading: false,
        freqsError: null,
      }));
    });

    return {
      loadFrequencies: actionMockState.loadFrequencies,
      loadCallsigns: actionMockState.loadCallsigns,
      loadNetworkActivity: actionMockState.loadNetworkActivity,
      loadPelengPoints: actionMockState.loadPelengPoints,
      setActiveNetworkDetailsTab: actionMockState.setActiveNetworkDetailsTab,
      toggleDescriptionExpanded: vi.fn(),
      toggleFrequencyGroupExpanded: vi.fn(),
      openFreqCreateWizard: vi.fn(),
      closeFreqCreateWizard: vi.fn(),
      setFreqCreateWizardForm: vi.fn(),
      saveFreqCreateWizard: vi.fn(),
      openFreqEditDrawer: vi.fn(),
      closeFreqEditDrawer: vi.fn(),
      setFreqEditDrawerForm: vi.fn(),
      saveFreqEditDrawer: vi.fn(),
      openFreqRowActions: vi.fn(),
      closeFreqRowActions: vi.fn(),
      openDeleteFreqDialog: vi.fn(),
      closeDeleteFreqDialog: vi.fn(),
      deleteFreq: vi.fn(),
      setCallsignSectionMode: vi.fn(),
      setCallsignStatusFilter: vi.fn(),
      toggleCallsignInterceptedExpanded: vi.fn(),
      openCallsignDrawerForCreate: vi.fn(),
      openCallsignDrawerForEdit: vi.fn(),
      closeCallsignDrawer: vi.fn(),
      setCallsignDrawerForm: vi.fn(),
      saveCallsignDrawer: vi.fn(),
      openCallsignDeleteDialog: vi.fn(),
      closeCallsignDeleteDialog: vi.fn(),
      deleteCallsign: vi.fn(),
      addKnownCallsignsToNetwork: vi.fn(),
      addInterceptedCallsignToNetwork: vi.fn(),
      setNetworkCallsignMarkerMode: vi.fn(),
      setRelationsSearch: vi.fn(),
      setRelationsEnabledFreqs: vi.fn(),
      setRelationsMinIntensity: vi.fn(),
      setRelationsShowLabels: vi.fn(),
      setRelationsSelectedNodeId: vi.fn(),
      setRelationsSelectedEdgeId: vi.fn(),
      setRelationsSince: vi.fn(),
      setRelationsTill: vi.fn(),
      openDescriptionDrawerForCreate: vi.fn(),
      openDescriptionDrawerForEdit: vi.fn(),
      setDescriptionDrawerForm: vi.fn(),
      closeDescriptionDrawer: vi.fn(),
      saveDescription: vi.fn(),
      openDeleteDescriptionDialog: vi.fn(),
      closeDeleteDescriptionDialog: vi.fn(),
      resetDeleteDescriptionDialog: vi.fn(),
      deleteDescription: vi.fn(),
      openMenu: vi.fn(),
      closeMenu: vi.fn(),
      openEtalonkaReportDialog: vi.fn(),
      closeEtalonkaReportDialog: vi.fn(),
      setEtalonkaReportType: vi.fn(),
      setEtalonkaReportActiveFreqsOnly: vi.fn(),
      setEtalonkaReportIncludeSigintSigns: vi.fn(),
      setEtalonkaReportIncludeConfirmation: vi.fn(),
      setEtalonkaReportIncludeUnitCallsigns: vi.fn(),
      setEtalonkaReportIncludePelengsMap: vi.fn(),
      setEtalonkaReportFromDateTimeStr: vi.fn(),
      setEtalonkaReportToDateTimeStr: vi.fn(),
      setEtalonkaReportProgressExpanded: vi.fn(),
      downloadEtalonkaReport: vi.fn(),
      openDeleteDialog: vi.fn(),
      closeDeleteDialog: vi.fn(),
      openEditDrawer: vi.fn(),
      closeEditDrawer: vi.fn(),
      setEditForm: vi.fn(),
      saveNetworkEdit: vi.fn(),
      handleCopyNetworkInfo: vi.fn(),
      handleCopyMainInfo: vi.fn(),
      handleDelete: vi.fn(),
      reload: vi.fn(),
      setCallsignDeleteAlsoFromCatalog: vi.fn(),
    };
  },
}));

import { useRerNetworkDetailsNeoPage } from '../use-rer-network-details-neo-page';

type Page = ReturnType<typeof useRerNetworkDetailsNeoPage>;

const rendered: Root[] = [];
let latestPage: Page | null = null;

function HookHarness() {
  latestPage = useRerNetworkDetailsNeoPage(42);
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
  loadMockState.currentUser = { roles: ['Rer'] } as User;
  loadMockState.loadNetworkActivity.mockClear();
  loadMockState.loadCallsigns.mockClear();
  loadMockState.loadRelations.mockClear();
  loadMockState.loadPelengPoints.mockClear();
  actionMockState.loadFrequencies.mockClear();
  actionMockState.loadCallsigns.mockClear();
  actionMockState.loadPelengPoints.mockClear();
  actionMockState.setActiveNetworkDetailsTab.mockClear();
  window.history.replaceState({}, '', '/rer-networks/42');
  document.body.innerHTML = '';
  vi.clearAllMocks();
});
describe('useRerNetworkDetailsNeoPage unit options', () => {
  it('filters blank-name units before building lookup options', () => {
    const page = renderHookHarness();

    expect(page.unitOptions).toEqual([
      { id: 1, label: '11 АК' },
      { id: 2, label: '11 АК' },
    ]);
  });

  it('puts all-band AOR first and filters blank posts', () => {
    const page = renderHookHarness();

    expect(page.aorOptions).toEqual([
      { id: 3, label: 'Вся смуга' },
      { id: 1, label: 'Альфа' },
      { id: 2, label: 'Бета' },
    ]);
    expect(page.postOptions).toEqual([{ id: 11, label: 'Пост A' }]);
  });

  it('does not load tab-owned data while descriptions are active', async () => {
    renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionMockState.loadFrequencies).toHaveBeenCalledTimes(0);
    expect(loadMockState.loadCallsigns).toHaveBeenCalledTimes(0);
    expect(loadMockState.loadNetworkActivity).toHaveBeenCalledTimes(0);
    expect(loadMockState.loadRelations).toHaveBeenCalledTimes(0);
    expect(loadMockState.loadPelengPoints).toHaveBeenCalledTimes(0);
  });

  it('honors the direction-finding tab URL override', async () => {
    window.history.replaceState({}, '', '/rer-networks/42?tab=direction-finding');

    renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestPage?.activeNetworkDetailsTab).toBe('direction-finding');
  });

  it('canonicalizes the initial url and updates it when switching tabs', async () => {
    window.history.replaceState({}, '', '/rer-networks/42');

    const page = renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestPage?.activeNetworkDetailsTab).toBe('descriptions');
    expect(window.location.pathname + window.location.search).toBe(
      '/rer-networks/42?tab=justifications',
    );

    act(() => {
      page.setActiveNetworkDetailsTab('callsigns');
    });

    expect(window.location.pathname + window.location.search).toBe(
      '/rer-networks/42?tab=callsigns',
    );
    expect(latestPage?.activeNetworkDetailsTab).toBe('callsigns');
  });

  it('restores the active tab from popstate', async () => {
    window.history.replaceState({}, '', '/rer-networks/42?tab=direction-finding');

    const page = renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      window.history.pushState({}, '', '/rer-networks/42?tab=callsigns');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(window.location.pathname + window.location.search).toBe(
      '/rer-networks/42?tab=callsigns',
    );
    expect(latestPage?.activeNetworkDetailsTab).toBe('callsigns');
  });

  it('falls back from gated tabs after permissions resolve', async () => {
    loadMockState.currentUser = null;
    window.history.replaceState({}, '', '/rer-networks/42?tab=activity');

    renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestPage?.activeNetworkDetailsTab).toBe('descriptions');
    expect(window.location.pathname + window.location.search).toBe(
      '/rer-networks/42?tab=justifications',
    );
  });

  it('falls back from a direct relations url when the user cannot view relations', async () => {
    loadMockState.currentUser = null;
    window.history.replaceState({}, '', '/rer-networks/42?tab=connections-graph');

    renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestPage?.activeNetworkDetailsTab).toBe('descriptions');
    expect(window.location.pathname + window.location.search).toBe(
      '/rer-networks/42?tab=justifications',
    );
    expect(loadMockState.loadRelations).toHaveBeenCalledTimes(0);
  });

  it('falls back from a direct activity url when the user cannot view activity', async () => {
    loadMockState.currentUser = null;
    window.history.replaceState({}, '', '/rer-networks/42?tab=activity');

    renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestPage?.activeNetworkDetailsTab).toBe('descriptions');
    expect(window.location.pathname + window.location.search).toBe(
      '/rer-networks/42?tab=justifications',
    );
    expect(loadMockState.loadNetworkActivity).toHaveBeenCalledTimes(0);
  });

  it('keeps a direct relations url when the user can view relations', async () => {
    loadMockState.currentUser = { roles: ['Api'] } as User;
    window.history.replaceState({}, '', '/rer-networks/42?tab=connections-graph');

    const page = renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(latestPage?.activeNetworkDetailsTab).toBe('relations');
    expect(window.location.pathname + window.location.search).toBe(
      '/rer-networks/42?tab=connections-graph',
    );

    act(() => {
      page.setRelationsSince('2024-06-01');
      page.setRelationsTill('2024-06-02');
    });

    expect(loadMockState.loadRelations).toHaveBeenCalled();
  });

  it('waits for resolved relations permissions before loading a direct relations url', async () => {
    loadMockState.currentUser = null;
    window.history.replaceState({}, '', '/rer-networks/42?tab=connections-graph');

    const page = renderHookHarness();
    expect(loadMockState.loadRelations).toHaveBeenCalledTimes(0);
    expect(latestPage?.activeNetworkDetailsTab).toBe('relations');
    expect(window.location.pathname + window.location.search).toBe(
      '/rer-networks/42?tab=connections-graph',
    );

    loadMockState.currentUser = { roles: ['Api'] } as User;

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadMockState.loadRelations).toHaveBeenCalled();
    expect(latestPage?.activeNetworkDetailsTab).toBe('relations');
    expect(window.location.pathname + window.location.search).toBe(
      '/rer-networks/42?tab=connections-graph',
    );

    const callsBefore = loadMockState.loadRelations.mock.calls.length;
    act(() => {
      page.setRelationsSince('2024-06-01');
    });

    expect(loadMockState.loadRelations.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('loads network activity only on the activity tab and does not reload on return', async () => {
    const page = renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadMockState.loadNetworkActivity).toHaveBeenCalledTimes(0);
    expect(actionMockState.loadFrequencies).toHaveBeenCalledTimes(0);

    act(() => {
      page.setActiveNetworkDetailsTab('activity');
    });

    expect(loadMockState.loadNetworkActivity).toHaveBeenCalledTimes(1);
    expect(actionMockState.loadFrequencies).toHaveBeenCalledTimes(0);

    act(() => {
      page.setActiveNetworkDetailsTab('callsigns');
      page.setActiveNetworkDetailsTab('activity');
    });

    expect(loadMockState.loadNetworkActivity).toHaveBeenCalledTimes(1);
  });

  it('loads frequencies only on the frequencies tab and does not reload on return', async () => {
    const page = renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(actionMockState.loadFrequencies).toHaveBeenCalledTimes(0);

    act(() => {
      page.setActiveNetworkDetailsTab('frequencies');
    });

    expect(actionMockState.loadFrequencies).toHaveBeenCalledTimes(1);

    act(() => {
      page.setActiveNetworkDetailsTab('descriptions');
      page.setActiveNetworkDetailsTab('frequencies');
    });

    expect(actionMockState.loadFrequencies).toHaveBeenCalledTimes(1);
  });

  it('loads callsigns only on the callsigns tab and does not reload on return', async () => {
    const page = renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadMockState.loadCallsigns).toHaveBeenCalledTimes(0);

    act(() => {
      page.setActiveNetworkDetailsTab('callsigns');
    });

    expect(loadMockState.loadCallsigns).toHaveBeenCalledTimes(1);

    act(() => {
      page.setActiveNetworkDetailsTab('signs');
      page.setActiveNetworkDetailsTab('callsigns');
    });

    expect(loadMockState.loadCallsigns).toHaveBeenCalledTimes(1);
  });

  it('loads activity only when permissions allow it', async () => {
    loadMockState.currentUser = { roles: ['Rer'] } as User;
    const page = renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      page.setActiveNetworkDetailsTab('activity');
    });

    expect(loadMockState.loadNetworkActivity).toHaveBeenCalledTimes(1);
  });

  it('reloads relations when the window changes and not when returning to the tab', async () => {
    const page = renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      page.setActiveNetworkDetailsTab('relations');
    });

    expect(loadMockState.loadRelations).toHaveBeenCalledTimes(1);

    act(() => {
      page.setRelationsSince('2024-06-01');
      page.setRelationsTill('2024-06-02');
    });

    expect(loadMockState.loadRelations).toHaveBeenCalledTimes(2);

    act(() => {
      page.setActiveNetworkDetailsTab('descriptions');
      page.setActiveNetworkDetailsTab('relations');
    });

    expect(loadMockState.loadRelations).toHaveBeenCalledTimes(2);
  });

  it('reloads peleng points when the window changes and not when returning to the tab', async () => {
    const page = renderHookHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      page.setActiveNetworkDetailsTab('direction-finding');
    });

    expect(loadMockState.loadPelengPoints).toHaveBeenCalledTimes(1);

    act(() => {
      page.setPelengSince('2024-06-01');
      page.setPelengTill('2024-06-02');
    });

    expect(loadMockState.loadPelengPoints).toHaveBeenCalledTimes(2);

    act(() => {
      page.setActiveNetworkDetailsTab('callsigns');
      page.setActiveNetworkDetailsTab('direction-finding');
    });

    expect(loadMockState.loadPelengPoints).toHaveBeenCalledTimes(2);
  });
});
