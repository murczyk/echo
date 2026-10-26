import DeleteIcon from '@mui/icons-material/Delete';
import { MaterialReactTable } from 'material-react-table';
import { useEffect, type MouseEvent } from 'react';
import type { DeviceAudioForwardingEntry } from '../../../../Bindings';
import { MrtRowActionButton } from '../../components/MrtRowActionButton';
import {
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  buildDefaultColumnOrder,
  mrtCustomCell,
  renderColumnActionsMenuItems,
  renderDefaultMrtEmptyRowsFallback,
  useAppMaterialReactTable,
} from '../../components/mui-customized/table/get-default-table-options';
import { MrtOverflowText } from '../../components/mui-customized/table/mrt-overflow';
import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { handleNavigateWithinSpaClick } from '../../utils/browser';

export const DEFAULT_COLUMN_VISIBILITY = { deviceName: true, groupName: true, status: true };
export const DEFAULT_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: Object.keys(DEFAULT_COLUMN_VISIBILITY),
  withRowNumbers: true,
  withRowActions: true,
});

const columns: AppMrtColumnDef<DeviceAudioForwardingEntry>[] = [
  {
    accessorKey: 'deviceName',
    header: 'Пристрій',
    size: 300,
    meta: { overflowMode: 'custom', overflowOwner: 'shared-text' },
    Cell: mrtCustomCell<DeviceAudioForwardingEntry>(({ row }) => {
      const href = `/devices/${row.original.deviceId}`;
      return (
        <MrtOverflowText
          displayValue={row.original.deviceName}
          fullValue={row.original.deviceName}
          interactive
          component="a"
          componentProps={{
            href,
            onClick: (event: MouseEvent<HTMLElement>) => handleNavigateWithinSpaClick(event, href),
          }}
          sx={{ color: 'primary.main', fontWeight: 600, textDecoration: 'none' }}
        />
      );
    }),
  },
  { accessorKey: 'groupName', header: 'Група', size: 300 },
  {
    id: 'status',
    header: 'Стан',
    size: 220,
    accessorFn: (entry) =>
      entry.deviceArchived ? 'Пристрій архівований' : entry.enabled ? 'Увімкнено' : 'Вимкнено',
  },
];

export function ForwardingTable({
  items,
  rowOffset,
  disabled,
  onRemove,
}: {
  items: DeviceAudioForwardingEntry[];
  rowOffset: number;
  disabled: boolean;
  onRemove: (entry: DeviceAudioForwardingEntry) => void;
}) {
  const tableState = useTableStateContext();
  const table = useAppMaterialReactTable({
    columns,
    data: items,
    getRowId: (entry) => `${entry.deviceId}:${entry.groupMasterKey}`,
    enableRowNumbers: true,
    displayColumnDefOptions: {
      'mrt-row-numbers': { Cell: ({ row }) => rowOffset + row.index + 1 },
    },
    enableRowActions: true,
    enableRowVirtualization: false,
    enableSorting: false,
    enableColumnFilters: false,
    enableGlobalFilter: false,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => (
      <MrtRowActionButton
        label={`Видалити пересилання ${row.original.deviceName} → ${row.original.groupName}`}
        icon={<DeleteIcon fontSize="small" />}
        tone="danger"
        disabled={disabled}
        onClick={() => onRemove(row.original)}
        opensModal
      />
    ),
    enableColumnOrdering: tableState.enableColumnOrdering,
    enableColumnResizing: tableState.enableColumnResizing,
    onColumnVisibilityChange: tableState.onColumnVisibilityChange,
    onColumnOrderChange: tableState.onColumnOrderChange,
    onColumnSizingChange: tableState.onColumnSizingChange,
    defaultColumn: { renderColumnActionsMenuItems },
    muiTableProps: { 'aria-label': 'Налаштовані пересилання транскрибації' },
    muiTablePaperProps: ({ table }) => getDefaultMrtPaperProps({ table, layout: 'workspace' }),
    muiTableContainerProps: ({ table }) =>
      getDefaultMrtContainerProps({
        layout: 'workspace',
        fullScreen: table.getState().isFullScreen,
        hasRows: items.length > 0,
      }),
    renderEmptyRowsFallback: ({ table }) =>
      renderDefaultMrtEmptyRowsFallback({ table, noDataMessage: 'Немає налаштованих пересилань' }),
    state: {
      columnVisibility: tableState.columnVisibility,
      columnOrder: tableState.columnOrder,
      columnSizing: tableState.columnSizing,
      density: tableState.density,
    },
  });

  useEffect(() => {
    tableState.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}
