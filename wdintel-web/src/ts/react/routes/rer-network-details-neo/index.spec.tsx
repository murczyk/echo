/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_STATE } from './use-rer-network-details-neo-page.types';
import { NO_DATA_LABEL } from '../../utils/misc';
import { navigateWithinSpa } from '../../utils/browser';

const useRerNetworkDetailsNeoPageMock = vi.hoisted(() => vi.fn());

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: ({ children, onClick, href }: { children: ReactNode; onClick?: () => void; href?: string }) =>
    href ? (
      <a href={href} onClick={onClick as any}>
        {children}
      </a>
    ) : (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  IconButton: ({ children, onClick, disabled }: { children: ReactNode; onClick?: (event: MouseEvent) => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick as any} disabled={disabled}>
      {children}
    </button>
  ),
  Menu: ({ children, open }: { children: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  MenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  CircularProgress: () => <div data-testid="circular-progress" />,
  Skeleton: ({ children }: { children?: ReactNode }) => <div>{children ?? 'skeleton'}</div>,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  useMediaQuery: () => false,
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ breakpoints: { down: () => '(max-width: 600px)' } }),
}));

vi.mock('./use-rer-network-details-neo-page', () => ({
  useRerNetworkDetailsNeoPage: useRerNetworkDetailsNeoPageMock,
}));

vi.mock('../../components/ConfirmDangerDialog', () => ({
  ConfirmDangerDialog: () => null,
}));

vi.mock('../../components/PageErrorState', () => ({
  PageErrorState: () => null,
}));

vi.mock('../../components/PageHeader', () => ({
  PageHeader: ({
    title,
    titleLeadingActions,
    actions,
  }: {
    title?: ReactNode;
    titleLeadingActions?: ReactNode;
    actions?: ReactNode;
  }) => (
    <header>
      {title}
      {titleLeadingActions}
      {actions}
    </header>
  ),
}));

vi.mock('../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../components/SidePanelToggleButton', () => ({
  SidePanelToggleButton: ({
    label,
    onClick,
    disabled,
  }: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" aria-label={label} onClick={onClick} disabled={disabled}>
      {label}
    </button>
  ),
}));

vi.mock('./components/NetworkDetailsLeftPanel', () => ({
  NetworkDetailsLeftPanel: ({
    placement,
    collapsed,
  }: {
    placement: string;
    collapsed: boolean;
  }) => (
    <div data-testid="left-panel" data-placement={placement} data-collapsed={String(collapsed)}>
      {placement}:{collapsed ? 'collapsed' : 'expanded'}
    </div>
  ),
}));

vi.mock('./components/NetworkDetailsLoadingState', () => ({
  NetworkDetailsLoadingState: () => <div data-testid="loading-state" />,
}));

vi.mock('./components/NetworkDetailsTabPanel', () => ({
  NetworkDetailsTabPanel: () => <div data-testid="tab-panel" />,
}));

vi.mock('./components/NetworkDescriptionDrawer', () => ({ NetworkDescriptionDrawer: () => null }));
vi.mock('./components/NetworkEditDrawer', () => ({ NetworkEditDrawer: () => null }));
vi.mock('./components/NetworkCallsignDrawer', () => ({ NetworkCallsignDrawer: () => null }));
vi.mock('./components/NetworkFreqCreateWizard', () => ({ NetworkFreqCreateWizard: () => null }));
vi.mock('./components/NetworkFreqEditDrawer', () => ({ NetworkFreqEditDrawer: () => null }));
vi.mock('./components/NetworkFreqTechDataDrawer', () => ({ NetworkFreqTechDataDrawer: () => null }));
vi.mock('./components/NetworkEtalonkaReportDialog', () => ({ NetworkEtalonkaReportDialog: () => null }));

vi.mock('@mui/icons-material/ContentCopyOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/Delete', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/Edit', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/MoreVertOutlined', () => ({ default: () => <span /> }));
vi.mock('@mui/icons-material/SummarizeOutlined', () => ({ default: () => <span /> }));
vi.mock('../../utils/browser', () => ({
  navigateWithinSpa: vi.fn(),
}));

import { RerNetworkDetailsNeoPage } from './index';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildPage(overrides: Record<string, unknown> = {}) {
  const noop = vi.fn();
  return {
    ...EMPTY_STATE,
    network: null,
    loading: false,
    error: null,
    referenceWarning: null,
    callsignWarning: null,
    copyStatus: null,
    copyStatusTone: null,
    status: { label: 'Завантаження', tone: 'warning' },
    canDelete: false,
    canEdit: false,
    canManageDescriptionActions: false,
    canManageCallsignActions: false,
    canDeleteCatalogCallsign: false,
    canViewActivityTab: false,
    canViewRelationsTab: false,
    isAdmin: false,
    unitNames: [],
    aorItems: [],
    postItems: [],
    rangeLabel: '—',
    transferTypeLabel: '—',
    aorOptions: [],
    unitOptions: [],
    postOptions: [],
    confirmationDescriptions: [],
    signDescriptions: [],
    activeNetworkDetailsTab: 'descriptions',
    setActiveNetworkDetailsTab: noop,
    loadFrequencies: noop,
    loadCallsigns: noop,
    loadNetworkActivity: noop,
    loadPelengPoints: noop,
    toggleDescriptionExpanded: noop,
    toggleFrequencyGroupExpanded: noop,
    openFreqCreateWizard: noop,
    closeFreqCreateWizard: noop,
    setFreqCreateWizardForm: noop,
    setFreqCreateWizardStep: noop,
    saveFreqCreateWizard: noop,
    openFreqEditDrawer: noop,
    closeFreqEditDrawer: noop,
    setFreqEditDrawerForm: noop,
    saveFreqEditDrawer: noop,
    openFreqTechDrawer: noop,
    closeFreqTechDrawer: noop,
    setFreqTechDrawerForm: noop,
    saveFreqTechDrawer: noop,
    openFreqRowActions: noop,
    closeFreqRowActions: noop,
    openDeleteFreqDialog: noop,
    closeDeleteFreqDialog: noop,
    deleteFreq: noop,
    setCallsignSectionMode: noop,
    setCallsignStatusFilter: noop,
    toggleCallsignInterceptedExpanded: noop,
    openCallsignDrawerForCreate: noop,
    openCallsignDrawerForEdit: noop,
    closeCallsignDrawer: noop,
    setCallsignDrawerForm: noop,
    saveCallsignDrawer: noop,
    openCallsignDeleteDialog: noop,
    closeCallsignDeleteDialog: noop,
    deleteCallsign: noop,
    addKnownCallsignsToNetwork: noop,
    addInterceptedCallsignToNetwork: noop,
    setNetworkCallsignMarkerMode: noop,
    setRelationsSearch: noop,
    setRelationsEnabledFreqs: noop,
    setRelationsMinIntensity: noop,
    setRelationsShowLabels: noop,
    setRelationsSelectedNodeId: noop,
    setRelationsSelectedEdgeId: noop,
    setRelationsSince: noop,
    setRelationsTill: noop,
    loadRelations: noop,
    openDescriptionDrawerForCreate: noop,
    openDescriptionDrawerForEdit: noop,
    setDescriptionDrawerForm: noop,
    closeDescriptionDrawer: noop,
    saveDescription: noop,
    openDeleteDescriptionDialog: noop,
    closeDeleteDescriptionDialog: noop,
    resetDeleteDescriptionDialog: noop,
    deleteDescription: noop,
    openMenu: noop,
    closeMenu: noop,
    openEtalonkaReportDialog: noop,
    closeEtalonkaReportDialog: noop,
    setEtalonkaReportType: noop,
    setEtalonkaReportActiveFreqsOnly: noop,
    setEtalonkaReportIncludeSigintSigns: noop,
    setEtalonkaReportIncludeConfirmation: noop,
    setEtalonkaReportIncludeUnitCallsigns: noop,
    setEtalonkaReportIncludePelengsMap: noop,
    setEtalonkaReportFromDateTimeStr: noop,
    setEtalonkaReportToDateTimeStr: noop,
    setEtalonkaReportProgressExpanded: noop,
    downloadEtalonkaReport: noop,
    openDeleteDialog: noop,
    closeDeleteDialog: noop,
    openEditDrawer: noop,
    closeEditDrawer: noop,
    setEditForm: noop,
    saveNetworkEdit: noop,
    handleCopyNetworkInfo: noop,
    handleCopyMainInfo: noop,
    handleDelete: noop,
    reload: noop,
    menuAnchorEl: null,
    callsignSectionMode: 'network',
    callsignStatusFilter: 'All',
    callsignInterceptedExpanded: false,
    callsignDrawerOpen: false,
    callsignDrawerMode: 'create',
    callsignDrawerForm: null,
    callsignDrawerSaving: false,
    callsignDrawerError: null,
    callsignDeleteDialogOpen: false,
    callsignDeleteTarget: null,
    callsignDeleteSubmitting: false,
    callsignDeleteError: null,
    callsignDeleteAlsoFromCatalog: false,
    descriptionDrawerOpen: false,
    descriptionDrawerMode: 'create',
    descriptionDrawerDescrType: 'Confirmation',
    descriptionDrawerDescriptionId: null,
    descriptionDrawerForm: { topic: '', description: '', networkFreqId: null },
    descriptionDrawerSaving: false,
    descriptionDrawerError: null,
    deleteDescriptionDialogOpen: false,
    deleteDescriptionTarget: null,
    deleteDescriptionSubmitting: false,
    deleteDescriptionError: null,
    expandedDescriptionIds: [],
    expandedFrequencyGroupIds: [],
    freqRowActionMenuAnchorEl: null,
    freqRowActionTargetId: null,
    freqCreateWizardOpen: false,
    freqCreateWizardStep: 1,
    freqCreateWizardForm: {
      freq: '',
      kind: 'DMR',
      modulationId: null,
      description: '',
      activeFrom: '',
      activeTo: '',
      encryptionKeyIds: [],
    },
    freqCreateWizardSaving: false,
    freqCreateWizardError: null,
    freqEditDrawerOpen: false,
    freqEditDrawerForm: null,
    freqEditDrawerSaving: false,
    freqEditDrawerError: null,
    freqTechDrawerOpen: false,
    freqTechDrawerForm: null,
    freqTechDrawerSaving: false,
    freqTechDrawerError: null,
    freqDeleteDialogOpen: false,
    freqDeleteTarget: null,
    freqDeleteSubmitting: false,
    freqDeleteError: null,
    etalonkaReport: {
      dialogOpen: false,
      taskRunId: 0,
      taskId: null,
      startedAtMs: null,
      running: false,
      curr: 0,
      overall: 4,
      logs: [],
      reportType: 'AccordingToTheForm',
      activeFreqsOnly: false,
      includeSigintSigns: false,
      includeConfirmation: false,
      includeUnitCallsigns: false,
      includePelengsMap: false,
      fromDateTimeStr: '',
      toDateTimeStr: '',
      downloadFileName: null,
      error: null,
      finishedAt: null,
      progressExpanded: false,
    },
    deleteDialogOpen: false,
    deleteInProgress: false,
    editDrawerOpen: false,
    editForm: null,
    editInProgress: false,
    editError: null,
    ...overrides,
  } as any;
}

async function renderPage(): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<RerNetworkDetailsNeoPage networkId={42} />);
  });

  return { container, root };
}

describe('RerNetworkDetailsNeoPage', () => {
  const rendered: Rendered[] = [];

  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
        clear: () => {
          storage.clear();
        },
      },
    });
  });

  afterEach(() => {
    useRerNetworkDetailsNeoPageMock.mockReset();
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
  });

  it('defaults to the left placement when storage is empty', async () => {
    useRerNetworkDetailsNeoPageMock.mockReturnValue(buildPage());
    const view = await renderPage();
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="left-panel"]')?.getAttribute('data-placement')).toBe('left');
    const toggleButton = view.container.querySelector('button[aria-label="Згорнути ліву панель"]');
    expect(toggleButton?.hasAttribute('disabled')).toBe(false);
    expect(window.localStorage.getItem('rer-network-details.preferredView')).toBe('neo');
  });

  it('disables the side toggle immediately when storage says top placement', async () => {
    window.localStorage.setItem('rer-network-details-neo.panelPlacement', 'top');
    useRerNetworkDetailsNeoPageMock.mockReturnValue(buildPage());
    const view = await renderPage();
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="left-panel"]')?.getAttribute('data-placement')).toBe('top');
    const toggleButton = view.container.querySelector('button[aria-label="Панель відображається зверху"]');
    expect(toggleButton?.hasAttribute('disabled')).toBe(true);
  });

  it('shows the empty-network fallback for loaded unnamed networks', async () => {
    useRerNetworkDetailsNeoPageMock.mockReturnValue(
      buildPage({
        network: { name: '', status: 'NetworkActive', deleted: false },
        unitNames: [],
        currentUserLoaded: true,
      }),
    );
    const view = await renderPage();
    rendered.push(view);

    expect(view.container.textContent).not.toContain('skeleton');
    expect(view.container.textContent).toContain(NO_DATA_LABEL);
  });

  it('keeps the tab area gated until permissions are loaded', async () => {
    useRerNetworkDetailsNeoPageMock.mockReturnValue(
      buildPage({
        network: { name: 'Тестова', status: 'NetworkActive', deleted: false },
        unitNames: [],
        currentUserLoaded: false,
      }),
    );
    const view = await renderPage();
    rendered.push(view);

    expect(view.container.querySelector('[data-testid="circular-progress"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain('Завантажуємо права доступу');
    expect(view.container.querySelector('[data-testid="tab-panel"]')).toBeNull();
  });

  it('stores classic preference before navigating to the classic page', async () => {
    useRerNetworkDetailsNeoPageMock.mockReturnValue(buildPage());
    const view = await renderPage();
    rendered.push(view);

    const listLink = view.container.querySelector('a[href="/rer-networks-neo"]');
    const classicButton = Array.from(view.container.querySelectorAll('button, a')).find((element) =>
      element.textContent?.includes('До класичної версії'),
    );
    if (!(classicButton instanceof HTMLButtonElement)) throw new Error('button not found');

    await act(async () => {
      classicButton.click();
    });

    expect(window.localStorage.getItem('rer-network-details.preferredView')).toBe('classic');
    expect(navigateWithinSpa).toHaveBeenCalledWith('/rer-networks/42?view=classic');
    expect(listLink?.textContent).toBe('До списку мереж');
    expect(listLink?.getAttribute('href')).toBe('/rer-networks-neo');
  });

});
