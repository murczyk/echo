/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NetworkDialogs } from './NetworkDialogs';
import type { useRerNetworksNeoPage } from '../use-rer-networks-neo-page';

const editDrawerProps: Array<Record<string, unknown>> = [];
const reportDialogProps: Array<Record<string, unknown>> = [];
const confirmDialogProps: Array<Record<string, unknown>> = [];

vi.mock('@mui/material', () => ({
  MenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Paper: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Popper: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../components/ConfirmDangerDialog', () => ({
  ConfirmDangerDialog: (props: Record<string, unknown>) => {
    confirmDialogProps.push(props);
    return <div data-testid="confirm-danger-dialog" />;
  },
}));

vi.mock('../../rer-network-details-neo/components/NetworkEditDrawer', () => ({
  NetworkEditDrawer: (props: Record<string, unknown>) => {
    editDrawerProps.push(props);
    return <div data-testid={`network-edit-drawer-${props.mode as string}`} />;
  },
}));

vi.mock('../../rer-network-details-neo/components/NetworkEtalonkaReportDialog', () => ({
  NetworkEtalonkaReportDialog: (props: Record<string, unknown>) => {
    reportDialogProps.push(props);
    return <div data-testid="network-etalonka-report-dialog" />;
  },
}));

function buildPage(): ReturnType<typeof useRerNetworksNeoPage> {
  return {
    reportsMenuAnchorEl: null,
    setReportsMenuAnchorEl: vi.fn(),
    openTopReportDialog: vi.fn(),
    downloadInFlight: null,
    permissions: { canExport: true },
    etalonkaReport: {
      dialogOpen: true,
      taskRunId: 1,
      taskId: 7,
      startedAtMs: null,
      running: false,
      curr: 0,
      overall: 4,
      logs: [],
      error: null,
      reportType: 'AccordingToTheForm',
      activeFreqsOnly: true,
      includeFreqActiveFrom: false,
      includeFreqCreatedAt: true,
      includeCallsignFullNames: false,
      includeSigintSigns: true,
      includeConfirmation: true,
      includeUnitCallsigns: true,
      includePelengsMap: true,
      fromDateTimeStr: '',
      toDateTimeStr: '',
      downloadFileName: null,
      finishedAt: null,
      progressExpanded: false,
    },
    reportTargetRequest: null,
    reportTargetNetworkIds: [1],
    closeReportDialog: vi.fn(),
    downloadEtalonkaReport: vi.fn(),
    setEtalonkaReport: vi.fn(),
    loading: false,
    unitOptions: [],
    postOptions: [],
    encryptions: [],
    createDialog: {},
    createSubmitting: false,
    createError: null,
    closeCreateDialog: vi.fn(),
    setCreateDialog: vi.fn(),
    saveNetworkCreate: vi.fn(),
    editDialog: {},
    editSubmitting: false,
    editError: null,
    closeEditDialog: vi.fn(),
    setEditDialog: vi.fn(),
    saveNetworkEdit: vi.fn(),
    deleteDialogNetwork: { name: 'network-1' },
    deleteSubmitting: false,
    closeDeleteDialog: vi.fn(),
    confirmDeleteNetwork: vi.fn(),
    aorOptions: [],
    pages: [],
    rows: [],
    allRows: [],
    filters: { searchText: '', unitText: '', status: 'all', showOnlyInvestigating: false },
    setFilters: vi.fn(),
    posts: [],
    unitStatsView: [],
    selectedSidebarUnitFilter: null,
    onPickUnitFilter: vi.fn(),
    onToggleInvestigating: vi.fn(),
    onClearUnitFilter: vi.fn(),
    onClearInvestigatingFilter: vi.fn(),
    status: null,
    setStatus: vi.fn(),
    statusCounts: null,
    rowMenuAnchorEl: null,
    rowMenuNetworkId: null,
    setRowMenuAnchorEl: vi.fn(),
    setRowMenuNetworkId: vi.fn(),
    runDownload: vi.fn(),
    supportNonRerInterceptions: false,
    loadMoreNetworks: vi.fn(),
    sidebarOpen: false,
    setSidebarOpen: vi.fn(),
    refreshing: false,
    loadingMore: false,
    noMoreToLoad: true,
    setNetworks: vi.fn(),
    createErrorState: null,
    editErrorState: null,
    deleteSubmittingState: false,
  } as unknown as ReturnType<typeof useRerNetworksNeoPage>;
}

function buildBroadReportRequest() {
  return {
    filterFreq: null,
    filterUnit: null,
    filterUnitArmy: null,
    filterUnitDivision: null,
    filterUnitRegiment: null,
    filterUnitBattalion: null,
    filterText: null,
    filterName: null,
    filterLocation: null,
    showOnlyFurtherInverstigation: null,
    showInactive: true,
    showOnlyDeleted: false,
    statusFilter: null,
    aorIds: null,
    ids: null,
    limit: null,
    offset: null,
    sortBy: null,
  };
}

afterEach(() => {
  editDrawerProps.splice(0);
  reportDialogProps.splice(0);
  confirmDialogProps.splice(0);
  document.body.innerHTML = '';
});

describe('NetworkDialogs', () => {
  it('passes the shared restore-focus guard to row-action dialogs', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(createElement(NetworkDialogs, { page: buildPage() }));
    });

    expect(reportDialogProps.at(-1)?.disableRestoreFocus).toBe(true);
    expect(
      editDrawerProps.find((props) => props.mode === 'create')?.disableRestoreFocus,
    ).toBeUndefined();
    expect(editDrawerProps.find((props) => props.mode === 'edit')?.disableRestoreFocus).toBe(true);
    expect(confirmDialogProps.at(-1)?.disableRestoreFocus).toBe(true);

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('marks a broad etalonka report with a launch warning', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(NetworkDialogs, {
          page: {
            ...buildPage(),
            reportTargetRequest: buildBroadReportRequest(),
          },
        }),
      );
    });

    expect(reportDialogProps.at(-1)?.launchWarningText).toBe(
      'Цей звіт охоплює всі мережі. Сигнали й підтвердження збільшують час формування.',
    );

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
