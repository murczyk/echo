/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkFreqsRes } from '../../../../../Bindings';

vi.mock('material-react-table', () => ({
  MaterialReactTable: ({ table }: { table: any }) => {
    const callsignColumn = table.options.columns.find(
      (column: Record<string, any>) => column.id === 'callsignLabel',
    );
    return (
      <div>
        {table.options.data.map((row: Record<string, any>) => (
          <div key={row.id} data-testid={`row-${row.id}`}>
            {callsignColumn.Cell({ row: { original: row } })}
          </div>
        ))}
      </div>
    );
  },
  useMaterialReactTable: (options: Record<string, any>) => ({ options }),
}));

vi.mock('../../../components/mui-customized/table/table-state-provider', () => ({
  useTableStateContext: () => ({
    globalFilter: '',
    columnFilters: [],
    sorting: [{ id: 'displayFreq', desc: false }],
    columnOrder: [],
    columnSizing: {},
    columnVisibility: {},
    density: 'compact',
    enableColumnOrdering: false,
    enableColumnResizing: false,
    onChangeGlobalFilter: vi.fn(),
    onColumnFiltersChange: vi.fn(),
    onSortingChange: vi.fn(),
    onColumnOrderChange: vi.fn(),
    onColumnSizingChange: vi.fn(),
    onColumnVisibilityChange: vi.fn(),
    onTableInitialized: vi.fn(),
  }),
}));

vi.mock('../../../components/PowerChip', () => ({
  PowerChip: ({ label }: { label: ReactNode }) => <span>{label}</span>,
}));

vi.mock('../../../components/MrtRowActionButton', () => ({
  MrtRowActions: ({ children }: { children?: ReactNode }) => <>{children}</>,
  MrtRowActionButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

vi.mock('../../../components/mui-customized/table/get-default-table-options', () => ({
  getDefaultMRTOptions: () => ({ localization: {} }),
  buildDefaultColumnOrder: ({
    dataColumnIds,
    withRowNumbers,
    withRowActions,
  }: {
    dataColumnIds: string[];
    withRowNumbers?: boolean;
    withRowActions?: boolean;
  }) => [
    ...(withRowNumbers ? ['mrt-row-numbers'] : []),
    ...(withRowActions ? ['mrt-row-actions'] : []),
    ...dataColumnIds,
  ],
  renderColumnActionsMenuItems: () => [],
  renderDefaultMrtEmptyRowsFallback: () => null,
}));

vi.mock('../../../components/mui-customized/table/custom-styles', () => ({
  CUSTOM_STYLES: { muiTablePaperProps: {} },
  FULL_HEIGHT_LOADING_ROW_COUNT: 8,
  FULL_WIDTH_TABLE_PAPER_SX: {},
  getPageScrollTableContainerSx: () => ({}),
}));

vi.mock('../../../components/mui-customized/table/mrt-cell-text', () => ({
  renderMrtCellWithFallback: (_value: string, render: (text: string) => ReactNode) =>
    render(_value),
  renderMrtCellTextValue: (value: string) => <span>{value}</span>,
}));

vi.mock(
  '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions',
  () => ({
    InternalTableActions: () => null,
  }),
);

import { NetworkDetailsFrequenciesTable } from './NetworkDetailsFrequenciesTable';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

let root: Root | null = null;

function buildNetwork() {
  return {
    id: 1,
    freqs: [],
    unitIds: [],
    aorIds: [],
    name: 'Network 1',
    location: 'Location 1',
    radioStation: null,
    createdAt: 1,
    purpose: null,
    operationMode: null,
    operationType: null,
    operationPeriod: null,
    lastUpdatedAt: 1,
    lastUpdatedBy: null,
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
    status: 'active',
  };
}

function buildFreq(overrides: Partial<NetworkFreqsRes> = {}): NetworkFreqsRes {
  return {
    networkFreqId: 7,
    freq: '145.1000',
    modulationId: null,
    modulation: null,
    encryptionKeyIds: [],
    encryptionKeys: [],
    messageCount: 5,
    callsigns: null,
    lastDatetime: null,
    lastDatetimeInAor: null,
    createdAt: 1,
    isActive: true,
    activeFrom: 1,
    activeTo: null,
    kind: 'VHF',
    ...overrides,
  };
}

function renderTable(
  freqCallsignsById: Map<number, string[]>,
  freqCallsignsStatus: 'idle' | 'loading' | 'success' | 'error',
): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      createElement(NetworkDetailsFrequenciesTable, {
        network: buildNetwork(),
        loading: false,
        freqs: [buildFreq()],
        freqsLoaded: true,
        freqsLoading: false,
        freqsError: null,
        freqCallsignsById,
        freqCallsignsStatus,
        encryptions: [],
        expandedFrequencyGroupIds: [],
        onToggleFrequencyGroupExpanded: vi.fn(),
        onOpenFreqCreateWizard: vi.fn(),
        onOpenFreqEditDrawer: vi.fn(),
        onOpenDeleteFreqDialog: vi.fn(),
        onOpenFreqRowActions: vi.fn(),
        onCloseFreqRowActions: vi.fn(),
        freqRowActionMenuAnchorEl: null,
        freqRowActionTargetId: null,
        canManage: false,
        onReloadFrequencies: vi.fn(),
      }),
    );
  });

  return { container, root };
}

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  document.body.innerHTML = '';
});

describe('NetworkDetailsFrequenciesTable', () => {
  it('shows a callsign load error when the row is not hydrated and status is error', () => {
    const view = renderTable(new Map(), 'error');

    expect(view.container.textContent).toContain('Не завантажено');
    expect(view.container.querySelector('[aria-label="Не завантажено"]')).not.toBeNull();
  });

  it('keeps hydrated callsigns visible even when status is error', () => {
    const view = renderTable(new Map([[7, ['ALPHA']]]), 'error');

    expect(view.container.textContent).toContain('ALPHA');
    expect(view.container.textContent).not.toContain('Не завантажено');
  });
});
