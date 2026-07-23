/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CallsignInfoRes, Network, SummaryTableFreqRow, Unit } from '../../../../../Bindings';
import { CallsignChipsCell, CompactListCell } from './analysis-summary-table-cells';

const capturedRowActionProps: Array<{ label: string; opensModal?: boolean }> = [];
const capturedTableOptions: Array<Record<string, any>> = [];
const useMediaQueryMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('@mui/icons-material/DownloadOutlined', () => ({ default: () => <span>download</span> }));
vi.mock('@mui/icons-material/EditOutlined', () => ({ default: () => <span>edit</span> }));
vi.mock('@mui/icons-material/FilterAltOutlined', () => ({ default: () => <span>filter</span> }));
vi.mock('@mui/icons-material/MapOutlined', () => ({ default: () => <span>map</span> }));

vi.mock('@mui/material', () => ({
  Backdrop: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: (props: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    disableRipple?: boolean;
    disableTouchRipple?: boolean;
  }) => (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      data-disable-ripple={props.disableRipple ? 'true' : undefined}
      data-disable-touch-ripple={props.disableTouchRipple ? 'true' : undefined}
    >
      {props.children}
    </button>
  ),
  CircularProgress: () => <div>loading</div>,
  Dialog: (props: { children: ReactNode; open: boolean; disableRestoreFocus?: boolean }) =>
    props.open ? (
      <div
        data-testid="rename-dialog"
        data-disable-restore-focus={String(props.disableRestoreFocus ?? false)}
      >
        {props.children}
      </div>
    ) : null,
  DialogActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  FormControl: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  InputLabel: ({ children }: { children: ReactNode }) => <label>{children}</label>,
  MenuItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  Paper: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  Select: (props: {
    children: ReactNode;
    value: string;
    onChange?: (event: { target: { value: string } }) => void;
  }) => (
    <select
      value={props.value}
      onChange={(event) => props.onChange?.({ target: { value: event.currentTarget.value } })}
    >
      {props.children}
    </select>
  ),
  Skeleton: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TextField: (props: {
    label?: string;
    value?: string;
    onChange?: (event: { target: { value: string } }) => void;
    'aria-label'?: string;
    disabled?: boolean;
  }) => {
    const handleValueChange = (value: string) => props.onChange?.({ target: { value } });

    return (
      <label>
        <span>{props.label}</span>
        <input
          aria-label={props['aria-label'] ?? props.label}
          value={props.value ?? ''}
          disabled={props.disabled}
          onInput={(event) => handleValueChange((event.currentTarget as HTMLInputElement).value)}
          onChange={(event) => handleValueChange((event.currentTarget as HTMLInputElement).value)}
        />
      </label>
    );
  },
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useMediaQuery: useMediaQueryMock,
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ breakpoints: { down: vi.fn(() => 'down-sm') } }),
}));

vi.mock('material-react-table', () => ({
  useMaterialReactTable: (options: Record<string, any>) => {
    capturedTableOptions.push(options);
    return options;
  },
  MaterialReactTable: ({ table }: { table: any }) => {
    const columns = table.columns as Array<any>;
    const data = table.data as Array<any>;
    const callsignsColumn = columns.find((column) => column.id === 'callsignSearchText');
    const rowActionsColumn = columns.find((column) => column.id === 'rowActions');
    return (
      <>
        <div data-testid="callsigns-cell-overflow">
          {callsignsColumn?.muiTableBodyCellProps?.sx?.overflow ?? ''}
        </div>
        <div data-testid="default-head-bg">
          {table.defaultColumn?.muiTableHeadCellProps?.sx?.backgroundColor ?? ''}
        </div>
        <div data-testid="row-actions-enable-resizing">
          {String(rowActionsColumn?.enableResizing ?? '')}
        </div>
        <div data-testid="row-actions">
          {table.renderRowActions?.({ row: { original: data[0] } })}
        </div>
        <table aria-label={table.muiTableProps?.['aria-label']}>
          <thead>
            <tr>
              <th>№</th>
              {columns.map((column) => (
                <th key={column.id ?? column.accessorKey}>{column.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((rowData, index) => (
              <tr key={rowData.freq}>
                <td>{index + 1}</td>
                {columns.map((column) => {
                  const key = column.id ?? column.accessorKey;
                  const cellValue = column.Cell
                    ? column.Cell({ row: { original: rowData } })
                    : rowData[column.accessorKey];
                  return <td key={key}>{cellValue}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  },
}));

vi.mock('../../../components/PowerButton', () => ({
  Button: (props: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  ),
}));

vi.mock('../../../components/MrtRowActionButton', () => ({
  MrtRowActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MrtRowActionButton: (props: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    opensModal?: boolean;
  }) => {
    capturedRowActionProps.push({ label: props.label, opensModal: props.opensModal });
    return (
      <button
        type="button"
        aria-label={props.label}
        onClick={props.onClick}
        disabled={props.disabled}
        data-opens-modal={props.opensModal ? 'true' : 'false'}
      >
        {props.label}
      </button>
    );
  },
  mrtRowActionsColumnSize: () => 96,
  MRT_ROW_ACTION_MODAL_PROPS: { disableRestoreFocus: true },
}));

vi.mock('../../../components/SectionLoadingOverlay', () => ({
  SectionLoadingOverlay: (props: { open: boolean }) => (props.open ? <div>overlay</div> : null),
}));

vi.mock('../../../components/TableEmptyState', () => ({
  TableEmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock('../../../components/PowerChip', () => ({
  PowerChip: (props: { label: ReactNode }) => <span>{props.label}</span>,
}));

vi.mock('../../../components/mui-customized/table/get-default-table-options', () => ({
  buildDefaultColumnOrder: ({ dataColumnIds }: { dataColumnIds: string[] }) => dataColumnIds,
  getDefaultMRTOptions: () => ({ displayColumnDefOptions: {} }),
  renderColumnActionsMenuItems: () => [],
}));

vi.mock('../../../components/TableToolbarControls', () => ({
  TableToolbarControls: (props: {
    trailingActionsBeforeInternal?: ReactNode;
    trailingActions?: ReactNode;
    withGlobalTextFilter?: boolean;
  }) => (
    <div>
      {props.withGlobalTextFilter ? <input aria-label="Пошук" /> : null}
      {props.trailingActionsBeforeInternal}
      {props.trailingActions}
    </div>
  ),
}));

vi.mock(
  '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions',
  () => ({
    InternalTableActions: ({ children }: { children?: ReactNode }) => (
      <div>
        {children}
        <span>internal-actions</span>
      </div>
    ),
  }),
);

vi.mock('../../../components/mui-customized/table/table-state-provider', () => ({
  TableStateProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useTableStateContext: () => ({
    globalFilter: '',
    onChangeGlobalFilter: vi.fn(),
    tableInstance: null,
    onTableInitialized: vi.fn(),
    density: 'compact',
    columnVisibility: {},
    columnOrder: [],
    columnSizing: {},
    sorting: [],
    onColumnVisibilityChange: vi.fn(),
    onColumnOrderChange: vi.fn(),
    onColumnSizingChange: vi.fn(),
    onSortingChange: vi.fn(),
    enableColumnOrdering: false,
    enableColumnResizing: true,
  }),
}));

import { AnalysisSummaryTableCard } from './AnalysisSummaryTableCard';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

function buildRow(overrides: Partial<SummaryTableFreqRow> = {}): SummaryTableFreqRow {
  return {
    freq: '100.100',
    count: 3,
    callsigns: ['alpha'],
    units: ['1 обрмп', '2 обрмп'],
    locations: ['Херсон', 'Миколаїв'],
    coords: [],
    localityCoords: [{ locality: 'Херсон, область', count: 2, coords: [] }],
    ...overrides,
  };
}

function buildNetwork(overrides: Partial<Network> = {}): Network {
  return {
    id: 11,
    name: 'Мережа 11',
    freqs: [{ freq: '100.100', priority: 0 }],
    unitIds: [],
    ...overrides,
  } as Network;
}

function buildProps(
  overrides: Partial<ComponentProps<typeof AnalysisSummaryTableCard>> = {},
): ComponentProps<typeof AnalysisSummaryTableCard> {
  return {
    callsignInfoMap: {
      alpha: {
        res: [
          {
            id: 7,
            position: 'оператор',
            unit1: '1 обрмп',
            unit2: '',
            unitId: 1,
            networkIdsReportedIn: [],
          },
        ],
      } as CallsignInfoRes,
    },
    networkDisplayMap: { 11: 'р/м Сокіл' },
    networks: [buildNetwork()],
    onDownloadXlsx: vi.fn(),
    onRenameUnit: vi.fn().mockResolvedValue(undefined),
    onSelectFreq: vi.fn(),
    onShowFreqOnMap: vi.fn(),
    rows: [buildRow()],
    unitsMap: {
      1: { id: 1, army: '1', division: '', regiment: '', battalion: '', company: '' },
    } as Record<number, Unit>,
    ...overrides,
  };
}

async function renderComponent(
  props: ComponentProps<typeof AnalysisSummaryTableCard>,
): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AnalysisSummaryTableCard {...props} />);
  });
  return { container, root };
}

async function renderStandalone(node: ReactNode): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return { container, root };
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent?.includes(label) || item.getAttribute('aria-label') === label,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

function getInput(container: HTMLElement, label: string): HTMLInputElement {
  const input = Array.from(container.querySelectorAll('input')).find(
    (item) => item.getAttribute('aria-label') === label,
  );
  if (!(input instanceof HTMLInputElement)) throw new Error(`Input not found: ${label}`);
  return input;
}

function getTableRow(container: HTMLElement, rowIndex: number): HTMLTableRowElement {
  const row = container.querySelectorAll('tbody tr')[rowIndex];
  if (!(row instanceof HTMLTableRowElement)) throw new Error(`Row not found: ${rowIndex}`);
  return row;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
  });
}

describe('AnalysisSummaryTableCard', () => {
  const rendered: Rendered[] = [];

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    capturedRowActionProps.splice(0);
    capturedTableOptions.splice(0);
    useMediaQueryMock.mockReturnValue(false);
  });

  function getPaginationProps(): Record<string, any> {
    const options = capturedTableOptions.at(-1);
    if (!options) throw new Error('MRT options were not captured');
    const paginationProps = options.muiPaginationProps;
    return typeof paginationProps === 'function'
      ? paginationProps({ table: options })
      : paginationProps;
  }

  async function renderAtWidth(width: number): Promise<Rendered> {
    useMediaQueryMock.mockReturnValue(width < 600);
    return renderComponent(buildProps());
  }

  it('hides the page-size selector and prevents wrapping below 600px', async () => {
    const view = await renderAtWidth(599);
    rendered.push(view);

    const paginationProps = getPaginationProps();
    expect(paginationProps.showRowsPerPage).toBe(false);
    expect(paginationProps.sx['@media (max-width: 599.95px)'].flexWrap).toBe('nowrap');
  });

  it('keeps the page-size selector at the 600px breakpoint', async () => {
    const view = await renderAtWidth(600);
    rendered.push(view);

    expect(getPaginationProps().showRowsPerPage).toBe(true);
  });

  it('recalculates page-size visibility when the mounted table crosses the breakpoint', async () => {
    useMediaQueryMock.mockReturnValue(false);
    const props = buildProps();
    const view = await renderComponent(props);
    rendered.push(view);
    expect(getPaginationProps().showRowsPerPage).toBe(true);

    useMediaQueryMock.mockReturnValue(true);
    await act(async () => {
      view.root.render(<AnalysisSummaryTableCard {...props} sx={{}} />);
    });

    expect(getPaginationProps().showRowsPerPage).toBe(false);
  });

  it('preserves desktop page-size options', async () => {
    const view = await renderAtWidth(1200);
    rendered.push(view);

    const paginationProps = getPaginationProps();
    expect(paginationProps.rowsPerPageOptions).toEqual([25, 50, 100]);
    expect(paginationProps.showRowsPerPage).toBe(true);
  });

  it('renders the MRT frequency columns and keeps export actions', async () => {
    const view = await renderComponent(buildProps());
    rendered.push(view);

    expect(view.container.textContent).toContain('Частота');
    expect(view.container.textContent).toContain('К-сть');
    expect(view.container.textContent).toContain('Координати');
    expect(view.container.textContent).toContain('Позивні');
    expect(view.container.textContent).toContain('Підрозділи');
    expect(view.container.textContent).toContain('Локації');
    expect(view.container.textContent).toContain('Дії');
    expect(view.container.textContent).toContain('XLSX');
    expect(view.container.querySelector('[data-testid="default-head-bg"]')?.textContent).toBe(
      'var(--bs-body-bg)',
    );
  });

  it('disables resizing for the row actions column', async () => {
    const view = await renderComponent(buildProps());
    rendered.push(view);

    expect(
      view.container.querySelector('[data-testid="row-actions-enable-resizing"]')?.textContent,
    ).toBe('false');
  });

  it('keeps the first load skeleton free of the reload overlay', async () => {
    const view = await renderComponent(
      buildProps({
        loading: true,
        rows: [],
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).not.toContain('overlay');
  });

  it('shows a compact empty state without rendering the MRT footer', async () => {
    const view = await renderComponent(
      buildProps({
        loaded: true,
        rows: [],
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('Частоти за обраними параметрами відсутні');
    expect(view.container.querySelector('table')).toBeNull();
  });

  it('treats zero rows as loaded when the optional loaded prop is omitted', async () => {
    const props = buildProps({ rows: [], loading: false });
    delete props.loaded;
    const view = await renderComponent(props);
    rendered.push(view);

    expect(view.container.textContent).toContain('Частоти за обраними параметрами відсутні');
    expect(view.container.querySelector('table')).toBeNull();
  });

  it('routes filter and map row actions to the existing callbacks', async () => {
    const onSelectFreq = vi.fn();
    const onShowFreqOnMap = vi.fn();
    const view = await renderComponent(
      buildProps({
        onSelectFreq,
        onShowFreqOnMap,
      }),
    );
    rendered.push(view);

    await click(getButton(view.container, 'У фільтр'));
    await click(getButton(view.container, 'На мапі'));

    expect(onSelectFreq).toHaveBeenCalledWith('100.100');
    expect(onShowFreqOnMap).toHaveBeenCalledWith('100.100');
  });

  it('marks rename unit as modal and disables restore focus on the dialog', async () => {
    const view = await renderComponent(buildProps());
    rendered.push(view);

    expect(capturedRowActionProps).toEqual([
      { label: 'У фільтр', opensModal: undefined },
      { label: 'На мапі', opensModal: undefined },
      { label: 'Редагувати підрозділ', opensModal: true },
    ]);

    await click(getButton(view.container, 'Редагувати підрозділ'));
    expect(
      view.container
        .querySelector('[data-testid="rename-dialog"]')
        ?.getAttribute('data-disable-restore-focus'),
    ).toBe('true');
  });

  it('opens and closes the rename dialog from the actions column', async () => {
    const view = await renderComponent(buildProps());
    rendered.push(view);

    await click(getButton(view.container, 'Редагувати підрозділ'));
    expect(view.container.textContent).toContain('Редагувати підрозділ');
    expect(view.container.textContent).toContain('Частота 100.100');

    await click(getButton(view.container, 'Скасувати'));
    expect(view.container.textContent).not.toContain('Частота 100.100');
  });

  it('submits onRenameUnit after confirming the dialog', async () => {
    const onRenameUnit = vi.fn().mockResolvedValue(undefined);
    const view = await renderComponent(buildProps({ onRenameUnit }));
    rendered.push(view);

    await click(getButton(view.container, 'Редагувати підрозділ'));
    await changeInput(getInput(view.container, 'Назва підрозділу для частоти 100.100'), '77 обрмп');
    await click(getButton(view.container, 'Зберегти'));

    expect(onRenameUnit).toHaveBeenCalledWith('100.100', '1 обрмп', '77 обрмп');
  });

  it('uses a single editable field when only one unit is available', async () => {
    const onRenameUnit = vi.fn().mockResolvedValue(undefined);
    const view = await renderComponent(
      buildProps({
        onRenameUnit,
        rows: [buildRow({ units: ['1 обрмп'] })],
      }),
    );
    rendered.push(view);

    await click(getButton(view.container, 'Редагувати підрозділ'));

    expect(view.container.querySelector('select')).toBeNull();
    expect(getInput(view.container, 'Назва підрозділу для частоти 100.100')).toBeTruthy();

    await changeInput(getInput(view.container, 'Назва підрозділу для частоти 100.100'), '77 обрмп');
    await click(getButton(view.container, 'Зберегти'));

    expect(onRenameUnit).toHaveBeenCalledWith('100.100', '1 обрмп', '77 обрмп');
  });

  it('collapses callsigns after the first three and expands on demand', async () => {
    const view = await renderComponent(
      buildProps({
        rows: [
          buildRow({
            callsigns: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'],
          }),
        ],
      }),
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('ALPHA');
    expect(view.container.textContent).toContain('CHARLIE');
    expect(view.container.textContent).not.toContain('DELTA');
    expect(view.container.textContent).not.toContain('FOXTROT');
    expect(view.container.textContent).not.toContain('GOLF');
    expect(view.container.textContent).toContain('+4 ще');

    await click(getButton(view.container, '+4 ще'));
    expect(view.container.textContent).toContain('DELTA');
    expect(view.container.textContent).toContain('Згорнути');
  });

  it('shows expandable overflow controls for callsigns, units, and locations', async () => {
    const view = await renderComponent(
      buildProps({
        rows: [
          buildRow({
            callsigns: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'],
            units: ['unit-a', 'unit-b', 'unit-c', 'unit-d'],
            locations: ['loc-a', 'loc-b', 'loc-c', 'loc-d', 'loc-e'],
          }),
        ],
      }),
    );
    rendered.push(view);

    const row = getTableRow(view.container, 0);
    expect(row.children[5].textContent).toContain('+4 ще');
    expect(row.children[6].textContent).toContain('р/м Сокіл');
    expect(row.children[6].textContent).toContain('+3 ще');
    expect(row.children[7].textContent).toContain('+3 ще');
  });

  it('renders standalone callsign chip overflow control', async () => {
    const view = await renderStandalone(
      <CallsignChipsCell
        callsigns={[
          { callsign: 'alpha', tooltip: null, iconClass: '', isHighlighted: false },
          { callsign: 'bravo', tooltip: null, iconClass: '', isHighlighted: false },
          { callsign: 'charlie', tooltip: null, iconClass: '', isHighlighted: false },
          { callsign: 'delta', tooltip: null, iconClass: '', isHighlighted: false },
          { callsign: 'echo', tooltip: null, iconClass: '', isHighlighted: false },
        ]}
      />,
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('+2 ще');
    expect(getButton(view.container, '+2 ще').dataset.disableRipple).toBe('true');
    expect(getButton(view.container, '+2 ще').dataset.disableTouchRipple).toBe('true');
    await click(getButton(view.container, '+2 ще'));
    expect(view.container.textContent).toContain('DELTA');
    expect(view.container.textContent).toContain('Згорнути');
  });

  it('renders standalone compact list overflow controls', async () => {
    const view = await renderStandalone(
      <div>
        <CompactListCell items={['unit-a', 'unit-b', 'unit-c', 'unit-d']} />
        <CompactListCell items={['loc-a', 'loc-b', 'loc-c', 'loc-d', 'loc-e']} />
      </div>,
    );
    rendered.push(view);

    expect(view.container.textContent).toContain('+2 ще');
    expect(view.container.textContent).toContain('+3 ще');

    await click(getButton(view.container, '+2 ще'));
    expect(view.container.textContent).toContain('Згорнути');
  });
});
