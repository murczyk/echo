import { CircularProgress, Tooltip, Typography } from '@mui/material';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import React from 'react';

import { Login } from '../../../../Bindings';
import { Button } from '../../components/mui-customized/button';
import { CUSTOM_CELL_STYLES, CUSTOM_STYLES } from '../../components/mui-customized/table/custom-styles';
import { TableTopToolbar } from '../../components/mui-customized/table/components/table-top-toolbar';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { TableStateProvider, useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { listLogins } from '../../services/api/logins';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

const ROLE_OPTIONS = [
  'Admin',
  'Api',
  'Rer',
  'Bpla',
  'Full',
  'Basic',
  'UnitsEditor',
  'CallsignsEditor',
  'DeleteMsg',
  'NoAutoLogout',
];

const STATUS_FILTER_OPTIONS = [
  { text: 'Активний', value: 'Активний' },
  { text: 'Видалено адміном', value: 'Видалено адміном' },
  { text: 'Неактивний', value: 'Неактивний' },
  { text: 'Організм деактивовано', value: 'Організм деактивовано' },
  { text: 'Невідомо', value: 'Невідомо' },
];

const DEFAULT_COLUMNS_VISIBILITY = {
  login: true,
  roles: true,
  organism: true,
  zone: true,
  deltaLogin: true,
  createdAt: true,
  status: true,
};

const DEFAULT_COLUMN_ORDER = ['mrt-row-numbers', 'login', 'roles', 'organism', 'zone', 'deltaLogin', 'createdAt', 'status'];

const defaultMRTOptions = getDefaultMRTOptions<Login>();

type StatusInfo = {
  label: string;
  colorClass: string;
  detail?: string;
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function formatDate(value: number | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('uk-UA');
}

function formatDateTime(value: number | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uk-UA');
}

function formatOptionalLabel(value: string | null | undefined): string {
  if (!value || !value.trim()) return '—';
  return value;
}

function getStatusInfo(login: Login): StatusInfo {
  if (login.deleted) {
    if (login.deactivationReason === 'Admin') {
      return { label: 'Видалено адміном', colorClass: 'text-red-600' };
    }
    if (login.deactivationReason === 'Inactive') {
      return {
        label: 'Неактивний',
        colorClass: 'text-yellow-600',
        detail: login.lastActiveAt ? `Останній: ${formatDateTime(login.lastActiveAt)}` : undefined,
      };
    }
    if (login.organismEnabled === false) {
      return { label: 'Організм деактивовано', colorClass: 'text-red-600' };
    }
    return { label: 'Невідомо', colorClass: 'text-gray-600' };
  }

  if (login.organismEnabled === false) {
    return { label: 'Організм деактивовано', colorClass: 'text-red-600' };
  }

  return { label: 'Активний', colorClass: 'text-green-600' };
}

function useUsersColumns(): MRT_ColumnDef<Login>[] {
  return React.useMemo(
    () => [
      {
        header: 'Логін',
        accessorKey: 'login',
        size: 200,
      },
      {
        header: 'Ролі',
        id: 'roles',
        accessorFn: (row) => row.roles,
        Cell: ({ row }) => {
          if (row.original.roles.length === 0) return <span>—</span>;
          return (
            <div className="flex flex-wrap gap-1">
              {row.original.roles.map((role) => (
                <span key={role} className="badge badge--neutral" title={role}>
                  {role}
                </span>
              ))}
            </div>
          );
        },
        filterVariant: 'multi-select',
        filterSelectOptions: ROLE_OPTIONS,
        filterFn: 'arrIncludesSome',
        enableSorting: false,
        size: 260,
      },
      {
        header: 'Організм',
        id: 'organism',
        accessorFn: (row) => formatOptionalLabel(row.organismName),
        Cell: ({ row }) => {
          const label = formatOptionalLabel(row.original.organismName);
          return (
            <Tooltip title={label}>
              <span>{label}</span>
            </Tooltip>
          );
        },
        size: 220,
      },
      {
        header: 'Напрямок',
        id: 'zone',
        accessorFn: (row) => formatOptionalLabel(row.sigintZoneName),
        Cell: ({ row }) => {
          const label = formatOptionalLabel(row.original.sigintZoneName);
          return (
            <Tooltip title={label}>
              <span>{label}</span>
            </Tooltip>
          );
        },
        size: 200,
      },
      {
        header: 'Дельта логін',
        id: 'deltaLogin',
        accessorFn: (row) => formatOptionalLabel(row.deltaLogin),
        size: 180,
      },
      {
        header: 'Створено',
        id: 'createdAt',
        accessorFn: (row) => row.createdAt,
        Cell: ({ row }) => <span>{formatDate(row.original.createdAt)}</span>,
        size: 150,
      },
      {
        header: 'Статус',
        id: 'status',
        accessorFn: (row) => [getStatusInfo(row).label],
        Cell: ({ row }) => {
          const status = getStatusInfo(row.original);
          return (
            <div className="flex flex-col items-center text-center leading-tight">
              <span className={status.colorClass}>{status.label}</span>
              {status.detail ? <span className="text-xs text-muted-foreground">{status.detail}</span> : null}
            </div>
          );
        },
        filterVariant: 'multi-select',
        filterSelectOptions: STATUS_FILTER_OPTIONS,
        filterFn: 'arrIncludesSome',
        enableSorting: false,
        size: 200,
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

function UsersTable(props: { data: Login[] }) {
  const tableStateContext = useTableStateContext();
  const columns = useUsersColumns();
  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

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
    enableRowVirtualization: false,
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
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
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
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...(baseProps as any)?.sx,
          minWidth: 0,
          maxWidth: '100%',
          width: '100%',
        },
      };
    },
    muiTableContainerProps: {
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as any)?.sx,
        minWidth: 0,
        maxWidth: '100%',
        width: '100%',
        maxHeight: 'none',
        overflowX: 'auto',
        overflowY: 'visible',
      },
    },
    state,
  });

  React.useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function AdminUsersNeoPageBody() {
  const [logins, setLogins] = React.useState<Login[]>([]);
  const [status, setStatus] = React.useState<LoadingStatus>('idle');
  const [error, setError] = React.useState<string | null>(null);

  async function loadLogins() {
    setStatus('loading');
    setError(null);
    try {
      const rsp = await listLogins({ sortBy: 'LoginCreatedAtDesc', filterByRoles: null });
      setLogins(rsp.users ?? []);
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setError(formatErrorMessage(err));
    }
  }

  React.useEffect(() => {
    loadLogins();
  }, []);

  const renderTable = () => {
    if (status === 'loading') {
      return (
        <div className="flex items-center justify-center py-12">
          <CircularProgress size={28} />
        </div>
      );
    }
    if (status === 'error') {
      return <div className="text-center py-8 text-red-600">{error || 'Помилка завантаження'}</div>;
    }
    if (status === 'success') {
      return (
        <div className="table-responsive-modern w-full min-w-0">
          <UsersTable data={logins} />
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
            Користувачі
          </Typography>
        }
        withDatePicker={false}
        withGlobalTextFilter
        additionalActions={
          <Button variant="outlined" onClick={loadLogins}>
            Оновити
          </Button>
        }
      />

      {renderTable()}
    </div>
  );
}

export function AdminUsersNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-users-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
    >
      <AdminUsersNeoPageBody />
    </TableStateProvider>
  );
}
