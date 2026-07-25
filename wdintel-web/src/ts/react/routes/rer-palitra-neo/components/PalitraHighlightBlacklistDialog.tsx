import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
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
import type { MRT_ColumnDef, MRT_RowData } from 'material-react-table';
import { MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';

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
  getDefaultMRTOptions,
  renderDefaultMrtEmptyRowsFallback,
} from '../../../components/mui-customized/table/get-default-table-options';
import { highlightBlacklistLabelKey } from '../../../services/api/palitra';
import { deriveHighlightBlacklistPoints } from './PalitraHighlightBlacklistDialog.helpers';

type BlacklistRow = MRT_RowData & {
  id: string;
  label: string;
  normalizedLabel: string;
  entry: PalitraHighlightBlacklistEntry | null;
  isCurrentPoint: boolean;
};

type Props = {
  palitra: Palitra | null;
  data: Parameters<typeof deriveHighlightBlacklistPoints>[0] | null;
  entries: PalitraHighlightBlacklistEntry[];
  loading: boolean;
  error: string | null;
  mutationError: string | null;
  mutationBlocked: boolean;
  pendingEntryIds: Set<number>;
  pendingLabels: Set<string>;
  onRetry: () => void;
  onToggle: (label: string, entry: PalitraHighlightBlacklistEntry | null) => void;
  onClose: () => void;
};

const defaultMRTOptions = getDefaultMRTOptions<BlacklistRow>();
export const PALITRA_HIGHLIGHT_BLACKLIST_TABLE_HEAD_CELL_PROPS = {
  ...CUSTOM_STYLES.muiTableHeadCellProps,
  sx: {
    ...CUSTOM_STYLES.muiTableHeadCellProps.sx,
    '& .Mui-TableHeadCell-ResizeHandle-Wrapper': {
      mr: '-8px',
    },
  },
};

function buildRows(
  data: Parameters<typeof deriveHighlightBlacklistPoints>[0],
  entries: PalitraHighlightBlacklistEntry[],
): BlacklistRow[] {
  const derived = deriveHighlightBlacklistPoints(data, entries);
  const entriesByKey = new Map(
    entries.map((entry) => [highlightBlacklistLabelKey(entry.label), entry]),
  );

  return [
    ...derived.points.map((point): BlacklistRow => ({
      id: `point:${point.normalizedLabel}`,
      label: point.label,
      normalizedLabel: point.normalizedLabel,
      entry: entriesByKey.get(point.normalizedLabel) ?? null,
      isCurrentPoint: true,
    })),
    ...derived.missingEntries.map((entry): BlacklistRow => ({
      id: `entry:${entry.id}`,
      label: entry.label,
      normalizedLabel: highlightBlacklistLabelKey(entry.label),
      entry,
      isCurrentPoint: false,
    })),
  ];
}

function getActionLabel(row: BlacklistRow) {
  return row.entry ? 'Прибрати з чорного списку' : 'Додати до чорного списку';
}

export function PalitraHighlightBlacklistDialog({
  palitra,
  data,
  entries,
  loading,
  error,
  mutationError,
  mutationBlocked,
  pendingEntryIds,
  pendingLabels,
  onRetry,
  onToggle,
  onClose,
}: Props) {
  const [globalFilter, setGlobalFilter] = useState('');
  const rows = useMemo(() => (data ? buildRows(data, entries) : []), [data, entries]);
  const columns = useMemo<MRT_ColumnDef<BlacklistRow>[]>(
    () => [
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
        accessorFn: (row) => row.entry?.createdByLogin ?? null,
        header: 'Додано',
        enableGlobalFilter: false,
        enableColumnFilter: false,
        enableResizing: true,
        Cell: ({ row }) => row.original.entry?.createdByLogin || '—',
        minSize: 160,
        size: 220,
      },
    ],
    [],
  );

  useEffect(() => {
    if (palitra === null) setGlobalFilter('');
  }, [palitra]);

  const table = useMaterialReactTable({
    ...defaultMRTOptions,
    columns,
    data: error || loading ? [] : rows,
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
    enableRowNumbers: true,
    enableRowActions: true,
    enableRowSelection: false,
    enableRowVirtualization: rows.length > 100,
    enableColumnResizing: true,
    positionActionsColumn: 'first',
    globalFilterFn: 'contains',
    onGlobalFilterChange: setGlobalFilter,
    muiTableHeadCellProps: PALITRA_HIGHLIGHT_BLACKLIST_TABLE_HEAD_CELL_PROPS,
    renderRowActions: ({ row }) => {
      const pending = row.original.entry
        ? pendingEntryIds.has(row.original.entry.id)
        : pendingLabels.has(row.original.normalizedLabel);
      const actionLabel = pending
        ? `${getActionLabel(row.original)}…`
        : getActionLabel(row.original);
      return (
        <MrtRowActionButton
          label={actionLabel}
          disabled={mutationBlocked || pending}
          onClick={() => onToggle(row.original.label, row.original.entry)}
          icon={
            pending ? (
              <CircularProgress size={18} />
            ) : row.original.entry ? (
              <VisibilityOutlinedIcon fontSize="small" />
            ) : (
              <VisibilityOffOutlinedIcon fontSize="small" />
            )
          }
        />
      );
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        header: '№',
        enableResizing: false,
      },
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        header: 'Дії',
        enableResizing: false,
      },
    },
    state: {
      globalFilter,
      columnOrder: ['mrt-row-numbers', 'mrt-row-actions', 'label', 'createdByLogin'],
      isLoading: loading,
      showSkeletons: loading,
    },
    renderEmptyRowsFallback: ({ table: emptyTable }) =>
      renderDefaultMrtEmptyRowsFallback({
        table: emptyTable,
        noDataMessage: 'У палітрі немає придатних точок.',
        filteredMessage: 'Збігів не знайдено.',
      }),
    muiTablePaperProps: ({ table: paperTable }) => getDefaultMrtPaperProps({ table: paperTable }),
    muiTableContainerProps: ({ table: containerTable }) => {
      const containerProps = getDefaultMrtContainerProps({
        layout: 'list',
        fullScreen: containerTable.getState().isFullScreen,
        hasRows: rows.length > 0,
      });
      return {
        ...containerProps,
        sx: { ...((containerProps as { sx?: object }).sx ?? {}), maxHeight: 420 },
      };
    },
  });

  return (
    <Dialog open={palitra !== null} onClose={onClose} disableRestoreFocus fullWidth maxWidth="md">
      <DialogTitle>Чорний список</DialogTitle>
      <DialogContent sx={{ pb: 0 }}>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="subtitle1">{palitra?.name ?? ''}</Typography>
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
