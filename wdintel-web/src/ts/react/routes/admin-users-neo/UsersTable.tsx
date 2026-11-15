import EditIcon from '@mui/icons-material/Edit';
import LockResetIcon from '@mui/icons-material/LockReset';
import { Box, Typography } from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';
import type { AppMrtColumnDef } from '../../components/mui-customized/table/get-default-table-options';
import { canManageUser, useUserManagementScope } from './user-management-scope';

import { Login } from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../components/mui-customized/table/custom-styles';
import {
  renderColumnActionsMenuItems,
  useAppMaterialReactTable,
} from '../../components/mui-customized/table/get-default-table-options';
import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { updateLogin } from '../../services/api/logins';

import { buildUserLoadingRows } from './user-display';
import { toClearTotpReq } from './user-form-helpers';
import { useUsersColumns } from './useUsersColumns';
import type { AorColumnLookup } from './aor-column';
export function RowActions(props: {
  login: Login;
  onEdit: (login: Login) => void;
  onUserUpdated: (login: Login) => void;
}) {
  const { notify } = usePowerSnackbar();
  const organism = useUserManagementScope();
  const [isResettingTotp, setIsResettingTotp] = useState(false);

  async function handleReset2fa() {
    if (!props.login.totpEnabled || isResettingTotp) return;
    setIsResettingTotp(true);
    try {
      const updated = await updateLogin(toClearTotpReq(props.login));
      props.onUserUpdated(updated);
      notify({ message: '2FA скинуто', severity: 'success' });
    } catch (error) {
      notify({
        message: error instanceof Error && error.message ? error.message : 'Не вдалося скинути 2FA',
        severity: 'error',
      });
    } finally {
      setIsResettingTotp(false);
    }
  }

  if (!canManageUser(organism, props.login))
    return (
      <Typography
        variant="caption"
        color="text.secondary"
        className="whitespace-nowrap text-center"
      >
        Керує Admin
      </Typography>
    );
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', gap: 0.5 }}>
      <MrtRowActionButton
        label="Редагувати"
        onClick={() => props.onEdit(props.login)}
        icon={<EditIcon fontSize="small" />}
        opensModal
      />
      <MrtRowActions forceMenu>
        <MrtRowActionButton
          label="Скинути 2FA"
          onClick={() => {
            void handleReset2fa();
          }}
          disabled={!props.login.totpEnabled || isResettingTotp}
          icon={<LockResetIcon fontSize="small" />}
        />
      </MrtRowActions>
    </Box>
  );
}

export function UsersTable(props: {
  data: Login[];
  loading: boolean;
  aorLookup?: AorColumnLookup;
  onEdit: (login: Login) => void;
  onUserUpdated: (login: Login) => void;
  extraColumns?: AppMrtColumnDef<Login>[];
}) {
  const tableStateContext = useTableStateContext();
  const organism = useUserManagementScope();
  const actionsWidth = organism ? 112 : 76;
  const userColumns = useUsersColumns(props.onEdit, props.aorLookup);
  // The table caches accessor values per row until `data` changes, so new
  // AOR lookups need new rows for filtering to see them.
  const data = useMemo(
    () => (props.loading ? buildUserLoadingRows() : [...props.data]),
    [props.loading, props.data, props.aorLookup],
  );
  const columns = useMemo(
    () => [...userColumns, ...(props.extraColumns ?? [])],
    [userColumns, props.extraColumns],
  );
  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps =
    typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

  const state = {
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
  };

  const table = useAppMaterialReactTable({
    columns,
    data,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableRowActions: !props.loading,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => (
      <RowActions login={row.original} onEdit={props.onEdit} onUserUpdated={props.onUserUpdated} />
    ),
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
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: actionsWidth,
        minSize: actionsWidth,
        maxSize: actionsWidth,
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
    state,
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}
