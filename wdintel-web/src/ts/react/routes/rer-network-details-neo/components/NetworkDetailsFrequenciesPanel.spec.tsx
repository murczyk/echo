/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_NETWORK_FREQ_SORTING } from '../frequency-utils';

const capturedOptions: Array<Record<string, any>> = [];
let capturedTableStateProviderProps: Record<string, any> | null = null;
let root: ReturnType<typeof createRoot> | null = null;

vi.mock('material-react-table', () => ({
  MaterialReactTable: () => null,
  useMaterialReactTable: (options: Record<string, any>) => {
    capturedOptions.push(options);
    return options;
  },
}));

vi.mock('../../../components/mui-customized/table/table-state-provider', () => ({
  TableStateProvider: (props: { children: ReactNode; defaultSorting?: unknown }) => {
    capturedTableStateProviderProps = props as Record<string, any>;
    return props.children;
  },
  useTableStateContext: () => ({
    globalFilter: '',
    columnFilters: [],
    sorting: DEFAULT_NETWORK_FREQ_SORTING,
    columnOrder: [],
    columnSizing: {},
    columnVisibility: {},
    density: 'compact',
    enableColumnOrdering: false,
    enableColumnResizing: true,
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
  buildDefaultColumnOrder: ({ dataColumnIds, withRowNumbers, withRowActions }: { dataColumnIds: string[]; withRowNumbers?: boolean; withRowActions?: boolean }) => [
    ...(withRowNumbers ? ['mrt-row-numbers'] : []),
    ...(withRowActions ? ['mrt-row-actions'] : []),
    ...dataColumnIds,
  ],
  getDefaultMRTOptions: () => ({ localization: {} }),
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
  renderMrtCellWithFallback: (_value: string, render: (text: string) => ReactNode) => render(_value),
  renderMrtCellTextValue: (value: string) => value,
}));

vi.mock('../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions', () => ({
  InternalTableActions: () => null,
}));

import { NetworkDetailsFrequenciesPanel } from './NetworkDetailsFrequenciesPanel';

afterEach(() => {
  root?.unmount();
  root = null;
  capturedOptions.length = 0;
  capturedTableStateProviderProps = null;
  document.body.innerHTML = '';
});

describe('NetworkDetailsFrequenciesPanel', () => {
  it('enables sorting only for the requested columns and keeps displayFreq as the default sort', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(
        createElement(NetworkDetailsFrequenciesPanel, {
          network: null,
          loading: false,
          freqs: [],
          freqsLoaded: true,
          freqsLoading: false,
          freqsError: null,
          modulations: [],
          expandedFrequencyGroupIds: [],
          onToggleFrequencyGroupExpanded: vi.fn(),
          onOpenFreqCreateWizard: vi.fn(),
          onOpenFreqEditDrawer: vi.fn(),
          onOpenFreqTechDrawer: vi.fn(),
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

    const options = capturedOptions[0];
    expect(capturedTableStateProviderProps?.defaultSorting).toEqual(DEFAULT_NETWORK_FREQ_SORTING);
    expect(options?.enableSorting).toBe(true);
    expect(options?.manualSorting).toBe(true);
    expect(options?.initialState?.sorting).toEqual(DEFAULT_NETWORK_FREQ_SORTING);

    const columnsById = new Map((options?.columns as Array<Record<string, any>> ?? []).map((column) => [column.id, column]));
    expect(columnsById.get('displayFreq')).toEqual(expect.objectContaining({ enableSorting: true }));
    expect(columnsById.get('typeLabel')).toEqual(expect.objectContaining({ enableSorting: true }));
    expect(columnsById.get('encryptionLabel')).toEqual(expect.objectContaining({ enableSorting: true }));
    expect(columnsById.get('messageCount')).toEqual(expect.objectContaining({ enableSorting: true }));
    expect(columnsById.get('callsignLabel')).toEqual(expect.objectContaining({ enableSorting: false }));
    expect(columnsById.get('lastDatetime')).toEqual(expect.objectContaining({ enableSorting: false }));

    root.unmount();
    container.remove();
  });
});
