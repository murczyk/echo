/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NetworkCallsignRowView } from '../network-callsigns.types';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('@mui/icons-material/Delete', () => ({ default: () => null }));
vi.mock('@mui/icons-material/Edit', () => ({ default: () => null }));
vi.mock('@mui/icons-material/MilitaryTechOutlined', () => ({ default: () => null }));
vi.mock('@mui/icons-material/Star', () => ({ default: () => null }));

vi.mock('material-react-table', () => ({
  MaterialReactTable: ({ table }: { table: any }) => (
    <div data-testid="table">
      {table.options.renderRowActions?.({ row: { original: table.options.data[0] } })}
    </div>
  ),
  useMaterialReactTable: (options: any) => ({
    ...options,
    options,
    getState: () => ({ isFullScreen: false }),
  }),
}));

vi.mock('../../../components/MrtRowActionButton', () => ({
  MrtRowActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  MrtRowActionButton: (props: { label: string; onClick: () => void; disabled?: boolean }) => (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  ),
}));

vi.mock('../../../components/PowerAlert', () => ({ PowerAlert: () => null }));
vi.mock('../../../components/PowerChip', () => ({ PowerChip: () => null }));
vi.mock('../../../components/formatMrtCellTextValue', () => ({
  formatMrtCellTextValue: (value: string) => value,
}));
vi.mock('../../../components/mui-customized/table/custom-styles', () => ({
  CUSTOM_STYLES: { muiTablePaperProps: {} },
  FULL_HEIGHT_LOADING_ROW_COUNT: 8,
  FULL_WIDTH_TABLE_PAPER_SX: {},
  getPageScrollTableContainerSx: () => ({}),
}));
vi.mock('../../../components/mui-customized/table/get-default-table-options', () => ({
  mrtCustomCell: (renderer: any) => renderer,
  mrtTextCell: ({ displayValue }: any) => displayValue,
  getDefaultMRTOptions: () => ({ localization: {} }),
  useAppMaterialReactTable: (options: Record<string, unknown>) => ({
    ...options,
    options,
    getState: () => ({ isFullScreen: false }),
  }),
  buildDefaultColumnOrder: ({ dataColumnIds }: { dataColumnIds: string[] }) => dataColumnIds,
  renderColumnActionsMenuItems: () => [],
  renderDefaultMrtEmptyRowsFallback: () => null,
}));
vi.mock('../../../components/mui-customized/table/mrt-cell-text', () => ({
  renderMrtCellTextValue: (value: string) => <span>{value}</span>,
}));
vi.mock(
  '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions',
  () => ({ InternalTableActions: () => null }),
);
vi.mock('../../../components/mui-customized/table/table-state-provider', () => ({
  TableStateProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useTableStateContext: () => ({
    columnOrder: [],
    columnVisibility: {},
    columnSizing: {},
    density: 'comfortable',
    enableColumnOrdering: false,
    enableColumnResizing: false,
    onColumnOrderChange: vi.fn(),
    onColumnVisibilityChange: vi.fn(),
    onColumnSizingChange: vi.fn(),
    onTableInitialized: vi.fn(),
  }),
}));
vi.mock('./NetworkCallsignSourceUi', () => ({ NetworkCallsignSourceCell: () => null }));
vi.mock('./NetworkCallsignStatusUi', () => ({ NetworkCallsignStatusDot: () => null }));

import { NetworkCallsignsNetworkTable } from './NetworkCallsignsNetworkTable';

function createRow(overrides: Partial<NetworkCallsignRowView> = {}): NetworkCallsignRowView {
  return {
    id: 1,
    callsign: 'сокіл-1',
    fullName: '',
    status: 'catalog',
    statusLabel: 'Каталог',
    position: '',
    unitId: 1,
    unitName: '1 мб',
    lastDatetime: null,
    messageCount: 0,
    comment: '',
    sourceName: 'РО',
    knownCallsignId: 1,
    active: true,
    developing: false,
    mainRadioStation: false,
    unitDeveloping: false,
    sourceId: 1,
    radioFreq: null,
    networkId: 1,
    commandControl: false,
    ...overrides,
  };
}

function renderTable(row: NetworkCallsignRowView) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onSetMarkerMode = vi.fn();

  act(() => {
    root.render(
      <NetworkCallsignsNetworkTable
        title="Мережа"
        rows={[row]}
        loading={false}
        loadingError={null}
        canManage
        statusFilter="All"
        onStatusFilterChange={vi.fn()}
        onOpenEditDrawer={vi.fn()}
        onOpenDeleteDialog={vi.fn()}
        onSetMarkerMode={onSetMarkerMode}
        onReload={vi.fn()}
        inFlightUpdateIds={[]}
        inFlightDeleteIds={[]}
      />,
    );
  });

  return { container, root, onSetMarkerMode };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('NetworkCallsignsNetworkTable marker actions', () => {
  it.each([
    [createRow(), ['Зробити головною', 'Зробити ланкою управління']],
    [createRow({ mainRadioStation: true }), ['Зняти головну', 'Зробити ланкою управління']],
    [createRow({ commandControl: true }), ['Зробити головною', 'Зняти ланку управління']],
  ] as const)('renders only specific marker actions', (row, labels) => {
    const view = renderTable(row);

    expect(view.container.textContent).not.toContain('Очистити маркер');
    for (const label of labels) {
      expect(view.container.querySelector(`[aria-label="${label}"]`)).toBeTruthy();
    }

    view.root.unmount();
    view.container.remove();
  });

  it('clears each specific active marker through the shared none mode', () => {
    const view = renderTable(createRow({ mainRadioStation: true, commandControl: true }));

    act(() => {
      view.container.querySelector<HTMLButtonElement>('[aria-label="Зняти головну"]')?.click();
      view.container
        .querySelector<HTMLButtonElement>('[aria-label="Зняти ланку управління"]')
        ?.click();
    });

    expect(view.onSetMarkerMode).toHaveBeenNthCalledWith(1, expect.anything(), 'none');
    expect(view.onSetMarkerMode).toHaveBeenNthCalledWith(2, expect.anything(), 'none');
    view.root.unmount();
    view.container.remove();
  });
});
