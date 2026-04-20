/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CallsignInfoRes, Network, SummaryTableFreqRow, Unit } from '../../../../../Bindings';

vi.mock('@mui/icons-material/DownloadOutlined', () => ({ default: () => <span>download</span> }));
vi.mock('@mui/icons-material/EditOutlined', () => ({ default: () => <span>edit</span> }));
vi.mock('@mui/icons-material/FilterAltOutlined', () => ({ default: () => <span>filter</span> }));
vi.mock('@mui/icons-material/MapOutlined', () => ({ default: () => <span>map</span> }));

vi.mock('@mui/material', () => ({
  Backdrop: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Button: (props: { children: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  ),
  CircularProgress: () => <div>loading</div>,
  Dialog: (props: { children: ReactNode; open: boolean }) => (props.open ? <div data-testid="rename-dialog">{props.children}</div> : null),
  DialogActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  FormControl: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  InputLabel: ({ children }: { children: ReactNode }) => <label>{children}</label>,
  MenuItem: ({ children, value }: { children: ReactNode; value: string }) => <option value={value}>{children}</option>,
  Paper: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  Select: (props: {
    children: ReactNode;
    value: string;
    onChange?: (event: { target: { value: string } }) => void;
  }) => (
    <select value={props.value} onChange={(event) => props.onChange?.({ target: { value: event.currentTarget.value } })}>
      {props.children}
    </select>
  ),
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
}));

vi.mock('material-react-table', () => ({
  useMaterialReactTable: (options: unknown) => options,
  MaterialReactTable: ({ table }: { table: any }) => {
    const columns = table.columns as Array<any>;
    const data = table.data as Array<any>;
    return (
      <table aria-label={table.muiTableProps?.['aria-label']}>
        <thead>
          <tr>
            <th>№</th>
            {columns.map((column) => (
              <th key={column.id ?? column.accessorKey}>{column.header}</th>
            ))}
            <th>{table.displayColumnDefOptions?.['mrt-row-actions']?.header ?? 'Дії'}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((rowData, index) => (
            <tr key={rowData.freq}>
              <td>{index + 1}</td>
              {columns.map((column) => {
                const key = column.id ?? column.accessorKey;
                const cellValue = column.Cell ? column.Cell({ row: { original: rowData } }) : rowData[column.accessorKey];
                return <td key={key}>{cellValue}</td>;
              })}
              <td>{table.renderRowActions?.({ row: { original: rowData } })}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
  MrtRowActionButton: (props: { label: string; onClick: () => void; disabled?: boolean }) => (
    <button type="button" aria-label={props.label} onClick={props.onClick} disabled={props.disabled}>
      {props.label}
    </button>
  ),
  mrtRowActionsColumnSize: () => 96,
}));

vi.mock('../../../components/PowerChip', () => ({
  PowerChip: (props: { label: ReactNode }) => <span>{props.label}</span>,
}));

vi.mock('../../../components/mui-customized/table/custom-styles', () => ({
  FULL_WIDTH_TABLE_PAPER_SX: {},
  getPageScrollTableContainerSx: () => ({}),
}));

vi.mock('../../../components/mui-customized/table/get-default-table-options', () => ({
  buildDefaultColumnOrder: ({ dataColumnIds }: { dataColumnIds: string[] }) => dataColumnIds,
  getDefaultMRTOptions: () => ({ displayColumnDefOptions: {} }),
  renderColumnActionsMenuItems: () => [],
}));

vi.mock('../../../components/TableToolbarControls', () => ({
  TableToolbarControls: (props: { trailingActionsBeforeInternal?: ReactNode; trailingActions?: ReactNode; withGlobalTextFilter?: boolean }) => (
    <div>
      {props.withGlobalTextFilter ? <input aria-label="Пошук" /> : null}
      {props.trailingActionsBeforeInternal}
      {props.trailingActions}
    </div>
  ),
}));

vi.mock('../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions', () => ({
  InternalTableActions: ({ children }: { children?: ReactNode }) => <div>{children}<span>internal-actions</span></div>,
}));

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

function buildProps(overrides: Partial<ComponentProps<typeof AnalysisSummaryTableCard>> = {}): ComponentProps<typeof AnalysisSummaryTableCard> {
  return {
    callsignInfoMap: {
      alpha: {
        res: [{ id: 7, position: 'оператор', unit1: '1 обрмп', unit2: '', unitId: 1, networkIdsReportedIn: [] }],
      } as CallsignInfoRes,
    },
    networkDisplayMap: { 11: 'р/м Сокіл' },
    networks: [buildNetwork()],
    onDownloadGeojson: vi.fn(),
    onDownloadKmz: vi.fn(),
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

async function renderComponent(props: ComponentProps<typeof AnalysisSummaryTableCard>): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AnalysisSummaryTableCard {...props} />);
  });
  return { container, root };
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label) || item.getAttribute('aria-label') === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

function getInput(container: HTMLElement, label: string): HTMLInputElement {
  const input = Array.from(container.querySelectorAll('input')).find((item) => item.getAttribute('aria-label') === label);
  if (!(input instanceof HTMLInputElement)) throw new Error(`Input not found: ${label}`);
  return input;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
    expect(view.container.textContent).toContain('KMZ');
    expect(view.container.textContent).toContain('GEOJSON');
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
});
