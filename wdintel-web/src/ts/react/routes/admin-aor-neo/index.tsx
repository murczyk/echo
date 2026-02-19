import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import EditIcon from '@mui/icons-material/Edit';
import { CircularProgress, Tooltip, Typography } from '@mui/material';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import React from 'react';

import { AorCoordinates, AreaOfResponsibility } from '../../../../Bindings';
import { Button } from '../../components/mui-customized/button';
import { IconButton } from '../../components/mui-customized/icon-button';
import { CUSTOM_CELL_STYLES, CUSTOM_STYLES } from '../../components/mui-customized/table/custom-styles';
import { TableTopToolbar } from '../../components/mui-customized/table/components/table-top-toolbar';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { TableStateProvider, useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { AdminLocationConfigsNeoPage } from '../admin-location-configs-neo';
import { listAors } from '../../services/api/aor';
import { navigateWithinSpa, withBackTo } from '../../utils/browser';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

const DEFAULT_COLUMNS_VISIBILITY = {
  name: true,
  description: true,
  leftBound: true,
  rightBound: true,
  coordinates: true,
  isTopLevel: true,
};

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'name',
  'description',
  'leftBound',
  'rightBound',
  'coordinates',
  'isTopLevel',
];

const defaultMRTOptions = getDefaultMRTOptions<AreaOfResponsibility>();

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function buildEditHref(id: number): string {
  return withBackTo(`/admin/aor-neo/${id}`);
}

function buildCreateHref(): string {
  return withBackTo('/admin/aor-neo/new');
}

function formatCoords(coords: AorCoordinates | null): string {
  if (!coords) return 'Не вказано';
  return `${coords.latitude}, ${coords.longitude}`;
}

function useAorColumns(): MRT_ColumnDef<AreaOfResponsibility>[] {
  return React.useMemo(
    () => [
      {
        header: 'Назва',
        accessorKey: 'name',
        size: 220,
      },
      {
        header: 'Опис',
        accessorFn: (row) => row.description ?? '',
        id: 'description',
        size: 240,
      },
      {
        header: 'Ліва межа',
        accessorKey: 'leftBound',
        size: 120,
      },
      {
        header: 'Права межа',
        accessorKey: 'rightBound',
        size: 120,
      },
      {
        header: 'Координати',
        accessorFn: (row) => `${formatCoords(row.leftCoordinates)} ${formatCoords(row.rightCoordinates)}`,
        id: 'coordinates',
        Cell: ({ row }) => (
          <div className="text-sm">
            <div>Ліва: {formatCoords(row.original.leftCoordinates)}</div>
            <div>Права: {formatCoords(row.original.rightCoordinates)}</div>
          </div>
        ),
        enableSorting: false,
        size: 240,
      },
      {
        header: 'Топ-рівень',
        accessorFn: (row) => (row.isTopLevel ? 1 : 0),
        id: 'isTopLevel',
        Cell: ({ row }) => (
          <div className="flex justify-center">
            {row.original.isTopLevel ? (
              <CheckCircleIcon className="text-green-600" fontSize="small" />
            ) : (
              <CancelIcon className="text-red-600" fontSize="small" />
            )}
          </div>
        ),
        size: 120,
        muiTableBodyCellProps: () => ({
          sx: {
            justifyContent: 'center',
            ...CUSTOM_CELL_STYLES,
          },
        }),
      },
    ],
    [],
  );
}

type RowActionsProps = {
  aor: AreaOfResponsibility;
};

function RowActions(props: RowActionsProps) {
  return (
    <Tooltip title="Редагувати">
      <IconButton size="small" onClick={() => navigateWithinSpa(buildEditHref(props.aor.id))}>
        <EditIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

type AorTableProps = {
  data: AreaOfResponsibility[];
};

function AorTable(props: AorTableProps) {
  const columns = useAorColumns();
  const tableStateContext = useTableStateContext();

  const state = {
    showAlertBanner: false,
    globalFilter: tableStateContext.globalFilter,
    columnVisibility: tableStateContext.columnVisibility,
    columnFilters: tableStateContext.columnFilters,
    density: tableStateContext.density,
    sorting: tableStateContext.sorting,
    columnOrder: tableStateContext.columnOrder,
    columnSizing: tableStateContext.columnSizing,
  };

  const table = useMaterialReactTable({
    columns,
    data: props.data,
    ...defaultMRTOptions,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    columnFilterDisplayMode: 'popover',
    globalFilterFn: 'contains',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: tableStateContext.onSortingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    getColumnCanGlobalFilter: (column) => column.getIsVisible(),
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => <RowActions aor={row.original} />,
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: 80,
      },
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        muiTableBodyCellProps: () => ({
          sx: {
            justifyContent: 'center',
            ...CUSTOM_CELL_STYLES,
          },
        }),
      },
    },
    state,
  });

  React.useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function AdminAorNeoPageBody() {
  const [aors, setAors] = React.useState<AreaOfResponsibility[]>([]);
  const [loadStatus, setLoadStatus] = React.useState<LoadingStatus>('idle');
  const [loadError, setLoadError] = React.useState<string | null>(null);

  async function loadAorList() {
    setLoadStatus('loading');
    setLoadError(null);
    try {
      const list = await listAors({ sortBy: null });
      setAors(list);
      setLoadStatus('success');
    } catch (error) {
      setLoadStatus('error');
      setLoadError(formatErrorMessage(error));
    }
  }

  React.useEffect(() => {
    loadAorList();
  }, []);

  const renderTable = () => {
    if (loadStatus === 'loading') {
      return (
        <div className="flex items-center justify-center py-12">
          <CircularProgress size={28} />
        </div>
      );
    }
    if (loadStatus === 'error') {
      return <div className="text-center py-8 text-red-600">{loadError || 'Помилка завантаження'}</div>;
    }
    if (loadStatus === 'success') {
      return (
        <div className="table-responsive-modern">
          <AorTable data={aors} />
        </div>
      );
    }
    return null;
  };

  return (
    <div className="mt-2 w-full space-y-4">
      <TableTopToolbar
        header={
          <Typography variant="h5" className="!font-semibold">
            Смуги відповідальності
          </Typography>
        }
        withDatePicker={false}
        withGlobalTextFilter
        additionalActions={
          <Button variant="contained" onClick={() => navigateWithinSpa(buildCreateHref())}>
            Додати смугу
          </Button>
        }
      />

      {renderTable()}
      <AdminLocationConfigsNeoPage />
    </div>
  );
}

export function AdminAorNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-aor-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
    >
      <AdminAorNeoPageBody />
    </TableStateProvider>
  );
}
