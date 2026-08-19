import DeleteIcon from '@mui/icons-material/Delete';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import type { MRT_RowData } from 'material-react-table';
import { MaterialReactTable } from 'material-react-table';
import { useMemo, useState } from 'react';

import type { Palitra, PalitraHighlightBlacklistEntry } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { MrtRowActionButton } from '../../../components/MrtRowActionButton';
import { ActiveFiltersButton } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions/components/active-filters-button';
import { GlobalFilterTextField } from '../../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field';
import {
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  getDefaultMRTOptions,
  mrtTextCell,
  useAppMaterialReactTable,
  renderDefaultMrtEmptyRowsFallback,
} from '../../../components/mui-customized/table/get-default-table-options';

type BlacklistRow = MRT_RowData & PalitraHighlightBlacklistEntry;

type Props = {
  palitra: Palitra;
  entries: PalitraHighlightBlacklistEntry[];
  loading: boolean;
  error: string | null;
  mutationError: string | null;
  mutationBlocked: boolean;
  pendingEntryIds: Set<number>;
  onRetry: () => void;
  onDelete: (entry: PalitraHighlightBlacklistEntry) => void;
  onClose: () => void;
};

const defaultMRTOptions = getDefaultMRTOptions<BlacklistRow>();
export const PALITRA_HIGHLIGHT_BLACKLIST_TABLE_HEAD_CELL_PROPS = {
  ...CUSTOM_STYLES.muiTableHeadCellProps,
  sx: {
    ...CUSTOM_STYLES.muiTableHeadCellProps.sx,
    '& .Mui-TableHeadCell-ResizeHandle-Wrapper': { mr: '-8px' },
  },
};

export function PalitraHighlightBlacklistDialog({
  palitra,
  entries,
  loading,
  error,
  mutationError,
  mutationBlocked,
  pendingEntryIds,
  onRetry,
  onDelete,
  onClose,
}: Props) {
  const [globalFilter, setGlobalFilter] = useState('');
  const columns = useMemo<AppMrtColumnDef<BlacklistRow>[]>(
    () => [
      {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        id: 'mrt-row-numbers',
        header: '№',
        accessorFn: () => null,
        enableGlobalFilter: false,
        enableColumnFilter: false,
        enableResizing: false,
        enableSorting: false,
        size: 48,
        minSize: 48,
        maxSize: 48,
        grow: false,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => String(row.index + 1),
          fullValue: ({ row }) => String(row.index + 1),
        }),
      },
      {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        id: 'mrt-row-actions',
        header: 'Дії',
        enableGlobalFilter: false,
        enableColumnFilter: false,
        enableResizing: false,
        enableSorting: false,
        size: 48,
        minSize: 48,
        maxSize: 48,
        grow: false,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => {
          const pending = pendingEntryIds.has(row.original.id);
          return (
            <MrtRowActionButton
              label="Видалити"
              disabled={mutationBlocked || pending}
              onClick={() => onDelete(row.original)}
              tone="danger"
              icon={pending ? <CircularProgress size={18} /> : <DeleteIcon fontSize="small" />}
            />
          );
        },
      },
      {
        accessorKey: 'label',
        header: 'Назва',
        enableGlobalFilter: true,
        enableColumnFilter: false,
        enableResizing: true,
        minSize: 220,
        size: 360,
      },
      {
        id: 'createdByLogin',
        accessorFn: (row) => row.createdByLogin,
        header: 'Додано',
        enableGlobalFilter: false,
        enableColumnFilter: false,
        enableResizing: true,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => row.original.createdByLogin || '—',
          fullValue: ({ row }) => row.original.createdByLogin || '—',
        }),
        minSize: 160,
        size: 220,
      },
    ],
    [mutationBlocked, onDelete, pendingEntryIds],
  );
  const table = useAppMaterialReactTable({
    columns,
    data: error || loading ? [] : entries,
    enablePagination: false,
    enableBottomToolbar: false,
    enableTopToolbar: false,
    enableToolbarInternalActions: false,
    enableColumnActions: false,
    enableColumnFilters: false,
    enableColumnFilterModes: false,
    enableColumnOrdering: false,
    enableDensityToggle: false,
    enableGlobalFilter: true,
    enableHiding: false,
    enableSorting: false,
    enableRowNumbers: false,
    enableRowActions: false,
    enableRowSelection: false,
    enableRowVirtualization: entries.length > 100,
    enableColumnResizing: true,
    globalFilterFn: 'contains',
    onGlobalFilterChange: setGlobalFilter,
    muiTableHeadCellProps: PALITRA_HIGHLIGHT_BLACKLIST_TABLE_HEAD_CELL_PROPS,
    state: {
      columnOrder: ['mrt-row-numbers', 'mrt-row-actions', 'label', 'createdByLogin'],
      globalFilter,
      isLoading: loading,
      showSkeletons: loading,
    },
    renderEmptyRowsFallback: ({ table: emptyTable }) =>
      renderDefaultMrtEmptyRowsFallback({
        table: emptyTable,
        noDataMessage: 'У чорному списку немає точок.',
        filteredMessage: 'Збігів не знайдено.',
      }),
    muiTablePaperProps: ({ table: paperTable }) => getDefaultMrtPaperProps({ table: paperTable }),
    muiTableContainerProps: ({ table: containerTable }) => {
      const containerProps = getDefaultMrtContainerProps({
        layout: 'list',
        fullScreen: containerTable.getState().isFullScreen,
        hasRows: entries.length > 0,
      });
      return {
        ...containerProps,
        sx: { ...((containerProps as { sx?: object }).sx ?? {}), maxHeight: 420 },
      };
    },
  });

  return (
    <Dialog open onClose={onClose} disableRestoreFocus fullWidth maxWidth="md">
      <DialogTitle>Чорний список</DialogTitle>
      <DialogContent sx={{ pb: 0 }}>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="subtitle1">{palitra.name}</Typography>
          <Typography variant="body2" color="text.secondary">
            Точки з чорного списку не підсвічуються в картках повідомлень.
          </Typography>
          {error ? (
            <PowerAlert severity="error" action={<Button onClick={onRetry}>Повторити</Button>}>
              Не вдалося завантажити дані: {error}
            </PowerAlert>
          ) : (
            <>
              {mutationError ? (
                <PowerAlert severity="error">
                  Не вдалося змінити чорний список: {mutationError}
                </PowerAlert>
              ) : null}
              {mutationBlocked ? (
                <PowerAlert severity="warning">
                  Подальші зміни недоступні для цієї сесії діалогу.
                </PowerAlert>
              ) : null}
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 1,
                }}
              >
                <Box sx={{ width: { xs: '100%', sm: 360 }, maxWidth: '100%' }}>
                  <GlobalFilterTextField
                    globalFilter={globalFilter}
                    setGlobalFilter={setGlobalFilter}
                  />
                </Box>
                <ActiveFiltersButton table={table} columnFilters={[]} globalFilter={globalFilter} />
              </Box>
              <MaterialReactTable table={table} />
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Закрити</Button>
      </DialogActions>
    </Dialog>
  );
}
