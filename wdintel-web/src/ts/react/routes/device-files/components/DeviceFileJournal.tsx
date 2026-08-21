import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useMemo } from 'react';

import type { DeviceFileJournalEntry } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { EchoChip } from '../../../components/EchoChip';
import { PowerChip } from '../../../components/PowerChip';
import {
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  getDefaultMRTOptions,
  mrtItemsCell,
  mrtTextCell,
  useAppMaterialReactTable,
  renderDefaultMrtEmptyRowsFallback,
} from '../../../components/mui-customized/table/get-default-table-options';
import { DeviceAnalyticsTagFilterControls } from './DeviceAnalyticsTagFilterControls';
import { DeviceFileContentMarker } from './DeviceFileContentMarker';
import type { DeviceAnalyticsTagFilter } from '../types';
import type { DeviceAnalyticsTagsState } from '../use-device-analytics-tags';
import type { DeviceFileJournalState } from '../use-device-file-journal';

const defaultMrtOptions = getDefaultMRTOptions<DeviceFileJournalEntry>();
const fileCountFormatter = new Intl.NumberFormat('uk-UA');
const synchronizedAtFormatter = new Intl.DateTimeFormat('uk-UA', {
  dateStyle: 'short',
  timeStyle: 'medium',
});

function formatSynchronizedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : synchronizedAtFormatter.format(date);
}

function useJournalColumns(): AppMrtColumnDef<DeviceFileJournalEntry>[] {
  return useMemo(
    () => [
      {
        accessorKey: 'name',
        header: 'Назва файлу',
        size: 240,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => cell.getValue() as string,
          displaySx: { overflowWrap: 'anywhere' },
          fullValue: ({ cell }) => cell.getValue() as string,
        }),
      },
      {
        accessorKey: 'absolutePath',
        header: 'Шлях до файлу',
        size: 520,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => cell.getValue() as string,
          displaySx: { overflowWrap: 'anywhere' },
          fullValue: ({ cell }) => cell.getValue() as string,
        }),
      },
      {
        accessorKey: 'tags',
        header: 'Теги',
        size: 220,
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<DeviceFileJournalEntry, DeviceFileJournalEntry['tags'][number]>({
          items: ({ row }) => row.original.tags,
          renderItem: (tag) => <EchoChip label={tag.name} tone="primary" />,
          measurementScope: 'device-file-journal:tags',
          getItemKey: (tag) => tag.id,
          getItemText: (tag) => tag.name,
        }),
      },
      {
        accessorKey: 'hasContent',
        header: 'Контент',
        size: 110,
        meta: { overflowMode: 'none' },
        Cell: ({ cell }) => (
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <DeviceFileContentMarker hasContent={Boolean(cell.getValue())} />
          </Box>
        ),
        muiTableHeadCellProps: { align: 'center' },
        muiTableBodyCellProps: { align: 'center' },
      },
      {
        accessorKey: 'synchronizedAt',
        header: 'Дата й час синхронізації',
        size: 210,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => formatSynchronizedAt(cell.getValue() as string),
          fullValue: ({ cell }) => formatSynchronizedAt(cell.getValue() as string),
        }),
      },
    ],
    [],
  );
}

export function DeviceFileJournal({
  journal,
  tagsState,
  tagFilter,
  onTagFilterChange,
}: {
  journal: DeviceFileJournalState;
  tagsState: DeviceAnalyticsTagsState;
  tagFilter: DeviceAnalyticsTagFilter;
  onTagFilterChange: (filter: DeviceAnalyticsTagFilter) => void;
}) {
  const columns = useJournalColumns();
  const isInitialLoading = journal.loading && journal.entries.length === 0;
  const countLabel =
    journal.totalCount === null
      ? null
      : `${fileCountFormatter.format(journal.entries.length)} з ${fileCountFormatter.format(
          journal.totalCount,
        )} файлів`;
  const table = useAppMaterialReactTable({
    columns,
    data: journal.entries,
    getRowId: (row) => row.fileId,
    enableColumnActions: false,
    enableColumnFilters: false,
    enableColumnOrdering: false,
    enableColumnResizing: false,
    enableGlobalFilter: false,
    enableHiding: false,
    enableRowActions: false,
    enableRowNumbers: false,
    enableSorting: false,
    renderEmptyRowsFallback: ({ table: emptyTable }) =>
      renderDefaultMrtEmptyRowsFallback({
        table: emptyTable,
        noDataMessage: 'Синхронізованих файлів ще немає',
      }),
    muiTablePaperProps: ({ table: paperTable }) => ({
      ...getDefaultMrtPaperProps({
        table: paperTable,
        loading: isInitialLoading,
        layout: 'workspace',
      }),
      elevation: 0,
      sx: {
        ...getDefaultMrtPaperProps({
          table: paperTable,
          loading: isInitialLoading,
          layout: 'workspace',
        }).sx,
        border: 0,
        borderRadius: 0,
      },
    }),
    muiTableContainerProps: getDefaultMrtContainerProps({
      loading: isInitialLoading,
      layout: 'workspace',
      hasRows: journal.entries.length > 0,
    }),
    muiTableProps: {
      'aria-label': 'Журнал синхронізації файлів',
    },
    state: {
      isLoading: isInitialLoading,
      showLoadingOverlay: false,
      showProgressBars: false,
      showSkeletons: isInitialLoading,
    },
  });

  if (journal.error !== null && journal.entries.length === 0 && !journal.loading) {
    return (
      <Box sx={{ p: 2 }}>
        <Stack spacing={2}>
          <DeviceAnalyticsTagFilterControls
            tagsState={tagsState}
            filter={tagFilter}
            onChange={onTagFilterChange}
          />
          <PowerAlert
            severity="error"
            autoHideDuration={null}
            dismissible={false}
            action={
              <PowerButton color="inherit" size="small" onClick={() => void journal.reload()}>
                Спробувати ще раз
              </PowerButton>
            }
          >
            {journal.error.message}
          </PowerAlert>
        </Stack>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: '100%',
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <Box sx={{ flexShrink: 0, p: 2, borderBottom: 1, borderColor: 'divider' }}>
        <DeviceAnalyticsTagFilterControls
          tagsState={tagsState}
          filter={tagFilter}
          onChange={onTagFilterChange}
        />
      </Box>
      {countLabel !== null ? (
        <Box
          role="status"
          aria-label={`Показано ${countLabel}`}
          sx={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            px: 2,
            py: 1,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <PowerChip
            label={countLabel}
            color="default"
            interactive={false}
            fontSize="0.75rem"
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          />
        </Box>
      ) : null}

      <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
        <MaterialReactTable table={table} />
      </Box>

      {journal.loadMoreError !== null ? (
        <PowerAlert
          severity="error"
          autoHideDuration={null}
          dismissible={false}
          action={
            <PowerButton color="inherit" size="small" onClick={() => void journal.loadMore()}>
              Повторити
            </PowerButton>
          }
          sx={{ borderRadius: 0 }}
        >
          {journal.loadMoreError.message}
        </PowerAlert>
      ) : null}

      {journal.nextCursor !== null ? (
        <Box
          sx={{
            flexShrink: 0,
            borderTop: 1,
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            p: 1.25,
          }}
        >
          <PowerButton
            variant="outlined"
            disabled={journal.loading || journal.loadingMore}
            onClick={() => void journal.loadMore()}
            startIcon={journal.loadingMore ? <CircularProgress size={16} color="inherit" /> : null}
          >
            {journal.loadingMore ? 'Завантаження…' : 'Завантажити ще'}
          </PowerButton>
        </Box>
      ) : null}
    </Box>
  );
}
