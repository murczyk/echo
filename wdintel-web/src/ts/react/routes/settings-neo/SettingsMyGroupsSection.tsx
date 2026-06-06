import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useEffect, useMemo } from 'react';

import type { MyAdminSignalGroup, SignalGroupLogin } from '../../../../Bindings';
import { ELLIPSIS } from '../../utils/misc';
import { PowerAlert } from '../../components/PowerAlert';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../components/mui-customized/table/custom-styles';
import { getDefaultMRTOptions, renderColumnActionsMenuItems } from '../../components/mui-customized/table/get-default-table-options';
import { TableStateProvider, useTableStateContext } from '../../components/mui-customized/table/table-state-provider';

const DEFAULT_MY_GROUPS_COLUMNS_VISIBILITY = {
  name: true,
  aors: true,
  admins: true,
  privacy: true,
  allowedUsers: true,
};

const DEFAULT_MY_GROUPS_COLUMN_ORDER = [
  'mrt-row-numbers',
  'name',
  'aors',
  'admins',
  'privacy',
  'allowedUsers',
];

const defaultMyGroupsMRTOptions = getDefaultMRTOptions<MyAdminSignalGroup>();

function formatAors(group: MyAdminSignalGroup): string {
  const aors = group.areasOfResponsibility ?? [];
  if (aors.length === 0) return '—';
  return aors.map((aor) => aor.name).join(', ');
}

function formatGroupLogin(login: SignalGroupLogin): string {
  if (!login.deltaLogin || login.login.toLocaleLowerCase() === login.deltaLogin.toLocaleLowerCase()) {
    return login.login;
  }
  return `${login.login} (${login.deltaLogin})`;
}

function formatGroupLogins(logins: SignalGroupLogin[]): string {
  if (logins.length === 0) return '—';
  return logins.map(formatGroupLogin).join(', ');
}

function formatAllowedUsers(group: MyAdminSignalGroup): string {
  if (!group.isGroupSecret) return 'без обмежень';
  return formatGroupLogins(group.allowedUsers);
}

function buildMyGroupLoadingRows(): MyAdminSignalGroup[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    masterKey: `loading-${index}`,
    name: '',
    datasourceName: null,
    datasourceKind: null,
    isGroupSecret: false,
    allowedUsers: [],
    adminLogins: [],
    areasOfResponsibility: null,
  }));
}

function useMyGroupsColumns() {
  return useMemo<MRT_ColumnDef<MyAdminSignalGroup>[]>(
    () => [
      {
        header: 'Група',
        id: 'name',
        accessorFn: (row) => row.name || row.masterKey.slice(-5),
        size: 160,
      },
      {
        header: 'Смуги',
        id: 'aors',
        accessorFn: formatAors,
        enableSorting: false,
        size: 130,
      },
      {
        header: 'Адміни',
        id: 'admins',
        accessorFn: (row) => formatGroupLogins(row.adminLogins),
        enableSorting: false,
        size: 180,
      },
      {
        header: 'Є приватною',
        id: 'privacy',
        accessorFn: (row) => (row.isGroupSecret ? 'так' : 'ні'),
        size: 110,
      },
      {
        header: 'Логіни приватної групи',
        id: 'allowedUsers',
        accessorFn: formatAllowedUsers,
        enableSorting: false,
        size: 250,
      },
    ],
    [],
  );
}

function SettingsMyGroupsTable(props: { groups: MyAdminSignalGroup[]; loading: boolean }) {
  const columns = useMyGroupsColumns();
  const tableStateContext = useTableStateContext();
  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

  const table = useMaterialReactTable({
    columns,
    data: props.loading ? buildMyGroupLoadingRows() : props.groups,
    ...defaultMyGroupsMRTOptions,
    layoutMode: 'grid-no-grow',
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
          ...FULL_WIDTH_TABLE_PAPER_SX,
        },
      };
    },
    muiTableContainerProps: {
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as any)?.sx,
        ...getPageScrollTableContainerSx({ loading: props.loading, idleOverflow: 'auto' }),
      },
    },
    state: {
      showAlertBanner: false,
      showLoadingOverlay: false,
      showSkeletons: props.loading,
      globalFilter: tableStateContext.globalFilter,
      columnVisibility: tableStateContext.columnVisibility,
      columnFilters: tableStateContext.columnFilters,
      density: tableStateContext.density,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

export type SettingsMyGroupsSectionProps = {
  status: 'idle' | 'loading' | 'success' | 'error';
  groups: MyAdminSignalGroup[];
  error: string | null;
};

export function SettingsMyGroupsSection({ status, groups, error }: SettingsMyGroupsSectionProps) {
  const hasGroups = groups.length > 0;

  return (
    <Box role="tabpanel" id="settings-neo-panel-my-groups" aria-labelledby="settings-neo-tab-my-groups">
      <Box sx={{ p: 3 }}>
        <Stack spacing={3}>
          <Typography component="h2" variant="h6" sx={{ fontWeight: 700, lineHeight: 1.25 }}>
            Мої групи
          </Typography>

          <PowerAlert severity="info">
            Для того щоби додати вашу приватну групу, додайте в неї телефон бота, написаний в описі групи підтримки, і напишіть адміністраторам повідомлення у форматі:
            <br />
            1. Додано групу МОЯ_ГРУПА (WhatsApp), зробіть мене (DeltaUser) адміном та групу приватною, видиму користувачам Delta1, Delta2, Delta3
            <br />
            2. Додано групу МОЯ_ГРУПА (Signal), зробіть мене (DeltaUser) адміном та групу публічною, на смугу 99АК
          </PowerAlert>

          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

          {status === 'loading' ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                Завантаження груп{ELLIPSIS}
              </Typography>
            </Box>
          ) : null}

          {status === 'success' && hasGroups ? (
            <TableStateProvider
              tableId="settings-neo-my-groups-v2"
              defaultColumnOrder={DEFAULT_MY_GROUPS_COLUMN_ORDER}
              defaultColumnVisibility={DEFAULT_MY_GROUPS_COLUMNS_VISIBILITY}
              defaultEnableColumnOrdering={false}
            >
              <Box sx={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
                <SettingsMyGroupsTable groups={groups} loading={false} />
              </Box>
            </TableStateProvider>
          ) : null}

          {status === 'success' && !hasGroups ? (
            <Box
              sx={{
                border: 1,
                borderColor: 'divider',
                borderRadius: 2,
                p: { xs: 2, sm: 2.5 },
                bgcolor: 'background.paper',
              }}
            >
              <Stack spacing={1}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  Груп не знайдено
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Тут з&apos;являться групи, коли для вашого облікового запису знайдуться приватні або керовані групи.
                </Typography>
              </Stack>
            </Box>
          ) : null}
        </Stack>
      </Box>
    </Box>
  );
}
