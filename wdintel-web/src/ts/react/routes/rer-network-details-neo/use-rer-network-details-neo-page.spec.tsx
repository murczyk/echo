/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Unit } from '../../../../Bindings';
import { EMPTY_STATE } from './use-rer-network-details-neo-page.types';

const loadMockState = vi.hoisted(() => ({
  loaded: false,
}));

vi.mock('./use-rer-network-details-neo-page.load', () => ({
  useRerNetworkDetailsNeoPageLoad: (
    _networkId: number,
    setState: (updater: (current: typeof EMPTY_STATE) => typeof EMPTY_STATE) => void,
  ) => {
    if (!loadMockState.loaded) {
      loadMockState.loaded = true;
      setState((current) => ({
        ...current,
        units: [
          { id: 1, name: '11 АК' } as Unit,
          { id: 2, name: ' 11 АК ' } as Unit,
          { id: 3, name: '' } as Unit,
        ],
      }));
    }

    return {
      reload: vi.fn(),
      loadCallsigns: vi.fn(),
      loadRelations: vi.fn(),
      loadNetworkActivity: vi.fn(),
      loadPelengPoints: vi.fn(),
    };
  },
}));

vi.mock('./use-rer-network-details-neo-page.actions', () => ({
  useRerNetworkDetailsNeoPageActions: () => ({
    loadFrequencies: vi.fn(),
    loadCallsigns: vi.fn(),
    loadNetworkActivity: vi.fn(),
    loadPelengPoints: vi.fn(),
    setActiveNetworkDetailsTab: vi.fn(),
    toggleDescriptionExpanded: vi.fn(),
    toggleFrequencyGroupExpanded: vi.fn(),
    openFreqCreateWizard: vi.fn(),
    closeFreqCreateWizard: vi.fn(),
    setFreqCreateWizardForm: vi.fn(),
    setFreqCreateWizardStep: vi.fn(),
    saveFreqCreateWizard: vi.fn(),
    openFreqEditDrawer: vi.fn(),
    closeFreqEditDrawer: vi.fn(),
    setFreqEditDrawerForm: vi.fn(),
    saveFreqEditDrawer: vi.fn(),
    openFreqTechDrawer: vi.fn(),
    closeFreqTechDrawer: vi.fn(),
    setFreqTechDrawerForm: vi.fn(),
    saveFreqTechDrawer: vi.fn(),
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
  }),
}));

import { useRerNetworkDetailsNeoPage } from './use-rer-network-details-neo-page';

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
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('useRerNetworkDetailsNeoPage unit options', () => {
  it('filters blank-name units before building lookup options', () => {
    const page = renderHookHarness();

    expect(page.unitOptions).toEqual([{ id: 1, label: '11 АК' }]);
  });
});
