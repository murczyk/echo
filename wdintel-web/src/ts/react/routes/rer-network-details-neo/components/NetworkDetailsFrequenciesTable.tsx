import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Box, Button, CircularProgress, Stack, Tooltip, Typography } from '@mui/material';
import {
  MaterialReactTable,
  useMaterialReactTable,
  type MRT_ColumnDef,
  type MRT_ColumnFiltersState,
} from 'material-react-table';
import { useEffect, useMemo } from 'react';

import type { ModulationRec, Network, NetworkFreqsRes } from '../../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../../components/MrtRowActionButton';
import {
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
  renderDefaultMrtEmptyRowsFallback,
} from '../../../components/mui-customized/table/get-default-table-options';
import { renderMrtCellWithFallback, renderMrtCellTextValue } from '../../../components/mui-customized/table/mrt-cell-text';
import { InternalTableActions } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { PowerChip } from '../../../components/PowerChip';
import { useTableStateContext } from '../../../components/mui-customized/table/table-state-provider';
import { formatDateTime24 } from '../../../utils/misc';
import {
  buildNetworkFreqRows,
  DEFAULT_NETWORK_FREQ_SORTING,
  sortNetworkFreqRowsByTableOrder,
  type NetworkFreqTableRow,
} from '../frequency-utils';
import {
  buildNetworkColumnOrder,
} from './NetworkCallsignsTableShared';

const defaultMRTOptions = getDefaultMRTOptions<NetworkFreqTableRow>();
const NETWORK_MRT_LOCALIZATION = {
  ...defaultMRTOptions.localization,
  rowNumbers: 'Номер рядка',
};
const DEFAULT_COLUMNS_VISIBILITY = {
  displayFreq: true,
  typeLabel: true,
  encryptionLabel: true,
  messageCount: true,
  callsignLabel: true,
  lastDatetime: true,
};
const COMPACT_LOADED_ROW_LIMIT = 8;
const STATUS_FILTER_COLUMN_ID = 'status';
const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};
type StatusFilterValue = 'Усі' | 'active' | 'inactive';

function getRowIsActive(row: NetworkFreqTableRow): boolean {
  return row.kind === 'group' ? row.isActive : row.freq.isActive;
}

function resolveStatusFilterValue(columnFilters: MRT_ColumnFiltersState): StatusFilterValue {
  const statusFilter = columnFilters.find((filter) => filter.id === STATUS_FILTER_COLUMN_ID);
  return statusFilter?.value === 'active' || statusFilter?.value === 'inactive' ? statusFilter.value : 'Усі';
}

function renderFrequencyStatusIndicator(isActive: boolean) {
  return (
    <Tooltip title={isActive ? 'Активна' : 'Неактивна'} arrow>
      <Box
        component="span"
        aria-label={isActive ? 'Активна' : 'Неактивна'}
        sx={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          bgcolor: isActive ? 'success.main' : 'warning.main',
          flexShrink: 0,
          cursor: 'default',
          mt: 0.1,
        }}
      />
    </Tooltip>
  );
}

function renderCategoryChip(label: string) {
  return renderMrtCellWithFallback(label, (text) => (
    <PowerChip
      size="small"
      color="default"
      label={text}
      fontSize="0.75rem"
      fontWeight={600}
      labelPaddingX={0.85}
      labelPaddingY={0.1}
      sx={{ height: 26, lineHeight: 1 }}
    />
  ));
}

function renderFrequencyCell(row: NetworkFreqTableRow) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, pl: row.kind === 'freq' && row.parentGroupId ? 4.5 : 0 }}>
      {renderFrequencyStatusIndicator(getRowIsActive(row))}
      <Typography variant="body2" fontWeight={600} noWrap title={row.displayFreq}>
        {row.displayFreq}
      </Typography>
    </Stack>
  );
}

function resolveLastDatetimeLabel(lastDatetime: number | null): string {
  return lastDatetime === null ? '—' : formatDateTime24(lastDatetime);
}

function getRowMessageCount(row: NetworkFreqTableRow): number {
  return row.kind === 'group' ? row.messageCount : row.freq.messageCount;
}

function getRowCallsignLabel(row: NetworkFreqTableRow): string {
  return row.callsignLabel;
}

function getRowLastDatetime(row: NetworkFreqTableRow): number | null {
  return row.kind === 'group' ? row.lastDatetime : row.freq.lastDatetime;
}

function buildLoadingRows(): NetworkFreqTableRow[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    id: `loading-freq-${index}`,
    kind: 'freq',
    parentGroupId: null,
    freq: {
      networkFreqId: -(index + 1),
      freq: '',
      modulationId: null,
      modulation: null,
      encryptionKeyIds: [],
      encryptionKeys: [],
      messageCount: 0,
      callsigns: [],
      lastDatetime: null,
      lastDatetimeInAor: null,
      createdAt: 0,
      isActive: true,
      activeFrom: 0,
      activeTo: null,
      kind: null,
    } as NetworkFreqsRes,
    displayFreq: '',
    typeLabel: '',
    encryptionLabel: '',
    callsignLabel: '',
    sortFreqUnits: null,
    sortNetworkFreqId: -(index + 1),
  }));
}

export type NetworkDetailsFrequenciesTableProps = {
  network: Network | null;
  loading: boolean;
  freqs: NetworkFreqsRes[];
  freqsLoaded: boolean;
  freqsLoading: boolean;
  freqsError: string | null;
  freqCallsignsById: Map<number, string[]>;
  freqCallsignsStatus: 'idle' | 'loading' | 'success' | 'error';
  modulations: ModulationRec[];
  expandedFrequencyGroupIds: string[];
  onToggleFrequencyGroupExpanded: (groupId: string) => void;
  onOpenFreqCreateWizard: () => void;
  onOpenFreqEditDrawer: (freq: NetworkFreqsRes) => void;
  onOpenDeleteFreqDialog: (freq: NetworkFreqsRes) => void;
  onOpenFreqRowActions: (anchorEl: HTMLElement, freqId: number) => void;
  onCloseFreqRowActions: () => void;
  freqRowActionMenuAnchorEl: HTMLElement | null;
  freqRowActionTargetId: number | null;
  canManage: boolean;
  onReloadFrequencies: () => void;
};

function buildColumns(
  freqCallsignsById: Map<number, string[]>,
  freqCallsignsStatus: 'idle' | 'loading' | 'success' | 'error',
): MRT_ColumnDef<NetworkFreqTableRow>[] {
  return [
    {
      header: 'Частота',
      accessorKey: 'displayFreq',
      id: 'displayFreq',
      size: 280,
      enableSorting: true,
      Cell: ({ row }) => renderFrequencyCell(row.original),
    },
    {
      header: 'Тип',
      accessorKey: 'typeLabel',
      id: 'typeLabel',
      size: 120,
      enableSorting: true,
      Cell: ({ row }) => renderCategoryChip(row.original.typeLabel),
    },
    {
      header: 'Шифрування',
      accessorKey: 'encryptionLabel',
      id: 'encryptionLabel',
      size: 180,
      enableSorting: true,
      Cell: ({ row }) => renderCategoryChip(row.original.encryptionLabel),
    },
    {
      header: 'К-сть',
      accessorKey: 'messageCount',
      id: 'messageCount',
      size: 110,
      enableSorting: true,
      Cell: ({ row }) => <Typography variant="body2" fontWeight={700}>{getRowMessageCount(row.original)}</Typography>,
    },
    {
      header: 'Позивні',
      accessorKey: 'callsignLabel',
      id: 'callsignLabel',
      size: 300,
      enableSorting: false,
      Cell: ({ row }) => {
        const label = getRowCallsignLabel(row.original);
        const freqIds = row.original.kind === 'group' ? row.original.freqIds : [row.original.freq.networkFreqId];
        const isLoaded = freqIds.every((freqId) => freqCallsignsById.has(freqId));
        if (freqCallsignsStatus === 'loading' && !isLoaded) {
          return <CircularProgress size={14} />;
        }
        return renderMrtCellTextValue(label, { title: label, sx: { maxWidth: '100%' }, noWrap: true });
      },
    },
    {
      header: 'Остання акт.',
      accessorFn: (row) => {
        const lastDatetime = getRowLastDatetime(row);
        return lastDatetime === null ? null : new Date(lastDatetime);
      },
      id: 'lastDatetime',
      size: 160,
      enableSorting: false,
      filterVariant: 'date-range',
      filterFn: 'betweenInclusive',
      Cell: ({ row }) => resolveLastDatetimeLabel(getRowLastDatetime(row.original)),
    },
  ];
}

function NetworkDetailsFrequenciesTableContent({
  network,
  loading,
  freqs,
  freqsLoaded,
  freqsLoading,
  freqsError,
  freqCallsignsById,
  freqCallsignsStatus,
  modulations,
  expandedFrequencyGroupIds,
  onToggleFrequencyGroupExpanded,
  onOpenFreqCreateWizard,
  onOpenFreqEditDrawer,
  onOpenDeleteFreqDialog,
  onOpenFreqRowActions,
  onCloseFreqRowActions,
  freqRowActionMenuAnchorEl,
  freqRowActionTargetId,
  canManage,
  onReloadFrequencies,
}: NetworkDetailsFrequenciesTableProps) {
  const tableStateContext = useTableStateContext();
  const modulationsById = useMemo(() => new Map(modulations.map((modulation) => [modulation.id, modulation.name])), [modulations]);
  const statusFilterValue = resolveStatusFilterValue(tableStateContext.columnFilters);
  const rows = useMemo(() => {
    const filteredFreqs =
      statusFilterValue === 'Усі'
        ? freqs
        : freqs.filter((freq) => (statusFilterValue === 'active' ? freq.isActive : !freq.isActive));
    const groupedRows = buildNetworkFreqRows(filteredFreqs, modulationsById, freqCallsignsById, expandedFrequencyGroupIds);
    return sortNetworkFreqRowsByTableOrder(groupedRows, tableStateContext.sorting, statusFilterValue);
  }, [expandedFrequencyGroupIds, freqs, freqCallsignsById, modulationsById, statusFilterValue, tableStateContext.sorting]);
  const loadingRows = useMemo(() => buildLoadingRows(), []);
  const isInitialLoading = loading || (freqsLoading && !freqsLoaded);
  const isCompactLoadedLayout = !isInitialLoading && rows.length <= COMPACT_LOADED_ROW_LIMIT;
  const hasActiveFilters = tableStateContext.columnFilters.length > 0 || Boolean(tableStateContext.globalFilter);
  void onOpenFreqRowActions;
  void onCloseFreqRowActions;
  void freqRowActionMenuAnchorEl;
  void freqRowActionTargetId;

  function onStatusFilterChange(nextStatusFilterValue: StatusFilterValue) {
    const nextFilters = tableStateContext.columnFilters.filter((filter) => filter.id !== STATUS_FILTER_COLUMN_ID);

    if (nextStatusFilterValue !== 'Усі') {
      nextFilters.push({ id: STATUS_FILTER_COLUMN_ID, value: nextStatusFilterValue });
    }

    tableStateContext.onColumnFiltersChange(nextFilters);
  }

  const statusFilterChips = (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <PowerChip label="Усі" selected={statusFilterValue === 'Усі'} onClick={() => onStatusFilterChange('Усі')} interactive fontSize="0.75rem" fontWeight={600} labelPaddingX={0.85} labelPaddingY={0.1} sx={{ height: 28, lineHeight: 1 }} />
      <PowerChip label="Активні" selected={statusFilterValue === 'active'} onClick={() => onStatusFilterChange('active')} interactive fontSize="0.75rem" fontWeight={600} labelPaddingX={0.85} labelPaddingY={0.1} sx={{ height: 28, lineHeight: 1 }} />
      <PowerChip label="Неактивні" selected={statusFilterValue === 'inactive'} onClick={() => onStatusFilterChange('inactive')} interactive fontSize="0.75rem" fontWeight={600} labelPaddingX={0.85} labelPaddingY={0.1} sx={{ height: 28, lineHeight: 1 }} />
    </Stack>
  );

  const columns = useMemo<MRT_ColumnDef<NetworkFreqTableRow>[]>(() => {
    return [...buildColumns(freqCallsignsById, freqCallsignsStatus)];
  }, [freqCallsignsById, freqCallsignsStatus]);
  const table = useMaterialReactTable({
    columns,
    data: isInitialLoading && rows.length === 0 ? loadingRows : rows,
    ...defaultMRTOptions,
    localization: NETWORK_MRT_LOCALIZATION,
    layoutMode: 'grid',
    enablePagination: false,
    enableBottomToolbar: false,
    enableTopToolbar: false,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    enableColumnFilters: true,
    enableColumnFilterModes: false,
    enableFacetedValues: true,
    enableHiding: true,
    enableSorting: true,
    manualSorting: true,
    enableMultiSort: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    enableRowVirtualization: false,
    enableRowSelection: false,
    columnFilterDisplayMode: 'popover',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onSortingChange: tableStateContext.onSortingChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    renderRowActions: ({ row }) => {
      if (isInitialLoading) return <Box sx={{ minHeight: 28 }} />;
      if (row.original.kind === 'group') {
        const groupRow = row.original;
        const isExpanded = expandedFrequencyGroupIds.includes(groupRow.groupId);
        return (
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <MrtRowActionButton
              label={isExpanded ? 'Згорнути групу частот' : 'Розгорнути групу частот'}
              onClick={() => onToggleFrequencyGroupExpanded(groupRow.groupId)}
              icon={isExpanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
            />
          </Box>
        );
      }
      if (!canManage) return <Box sx={{ minHeight: 28 }} />;
      const freqRow = row.original.freq;
      return (
        <MrtRowActions>
          <MrtRowActionButton label="Редагувати частоту" onClick={() => onOpenFreqEditDrawer(freqRow)} icon={<EditIcon fontSize="small" />} opensModal />
          <MrtRowActionButton label="Видалити" onClick={() => onOpenDeleteFreqDialog(freqRow)} icon={<DeleteIcon fontSize="small" />} tone="danger" opensModal />
        </MrtRowActions>
      );
    },
    state: {
      globalFilter: tableStateContext.globalFilter,
      columnVisibility: tableStateContext.columnVisibility,
      columnFilters: tableStateContext.columnFilters,
      density: tableStateContext.density,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
      isLoading: freqsLoading && freqsLoaded,
      showLoadingOverlay: freqsLoading && freqsLoaded,
      showSkeletons: freqsLoading && !freqsLoaded,
      showProgressBars: false,
    },
    defaultColumn: { size: 180, renderColumnActionsMenuItems },
    muiTablePaperProps: ({ table }) => ({
      ...((resolvedPaperProps({ table }) as object) ?? {}),
      sx: {
        ...((resolvedPaperProps({ table }) as { sx?: object }).sx ?? {}),
        ...FULL_WIDTH_TABLE_PAPER_SX,
        width: '100%',
        maxWidth: '100%',
        height: isCompactLoadedLayout ? 'auto' : '100%',
        minHeight: isCompactLoadedLayout ? 'auto' : 0,
        minWidth: 0,
        overflow: table.getState().isFullScreen ? 'auto' : isCompactLoadedLayout ? 'visible' : 'hidden',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 0,
        boxShadow: 'none',
      },
      style: {
        ...((resolvedPaperProps({ table }) as { style?: object }).style ?? {}),
        padding: 0,
      },
    }),
    muiTableContainerProps: ({ table }) => ({
      sx: {
        ...(isCompactLoadedLayout
          ? { flex: '0 0 auto', minHeight: 0, height: 'auto', maxHeight: 'none', overflowX: 'auto', overflowY: 'visible', WebkitOverflowScrolling: 'touch' }
          : getPageScrollTableContainerSx({ loading: freqsLoading, height: '100%', minHeight: 0, maxHeight: table.getState().isFullScreen ? '100%' : 'none', idleOverflow: 'auto' })),
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        height: isCompactLoadedLayout ? 'auto' : '100%',
      },
    }),
    muiTableBodyRowProps: ({ row }) => ({
      hover: true,
      sx: { opacity: row.original.kind === 'freq' && row.original.parentGroupId ? 0.96 : 1 },
    }),
    renderEmptyRowsFallback: ({ table }) =>
      renderDefaultMrtEmptyRowsFallback({
        table,
        noDataMessage: freqsError ? 'Не вдалося завантажити частоти' : 'Частоти відсутні',
        noDataActionLabel: freqsError ? 'Спробувати ще раз' : undefined,
        onNoDataAction: freqsError ? onReloadFrequencies : undefined,
        filteredMessage: 'Немає частот за обраними фільтрами',
        hasFilters: freqsError ? false : hasActiveFilters,
        onClearFilters: freqsError
          ? undefined
          : () => {
              tableStateContext.onColumnFiltersChange([]);
              tableStateContext.onChangeGlobalFilter('');
            },
      }),
    manualFiltering: false,
    initialState: {
      density: 'comfortable',
      sorting: DEFAULT_NETWORK_FREQ_SORTING,
      columnOrder: buildNetworkColumnOrder({
        dataColumnIds: ['displayFreq', 'typeLabel', 'encryptionLabel', 'messageCount', 'callsignLabel', 'lastDatetime'],
      }),
      columnVisibility: DEFAULT_COLUMNS_VISIBILITY,
    },
    getRowId: (row) => row.id,
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table, tableStateContext]);

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', width: '100%' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, px: 0, pt: 0, mb: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, width: '100%', minWidth: 0 }}>
          <Typography variant="h6">Частоти</Typography>
          {canManage ? <Button variant="contained" onClick={onOpenFreqCreateWizard} disabled={!network || freqsLoading}>Додати</Button> : null}
        </Box>
        {freqsError ? (
          <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Typography variant="body2" color="error">{freqsError}</Typography>
            <Button size="small" onClick={() => onReloadFrequencies()} disabled={freqsLoading}>Спробувати ще раз</Button>
          </Stack>
        ) : null}
      </Box>

      <Stack spacing={1.25} sx={{ minHeight: 0, minWidth: 0, flex: isCompactLoadedLayout ? '0 0 auto' : 1, width: '100%' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, width: '100%', minWidth: 0 }}>
          <Box sx={{ minWidth: 0 }}>{statusFilterChips}</Box>
          <Box sx={{ flexShrink: 0 }}><InternalTableActions table={table} rowNumberAppearanceControl /></Box>
        </Box>
        <Box sx={{ flex: isCompactLoadedLayout ? '0 0 auto' : 1, minHeight: 0, minWidth: 0, display: 'flex', width: '100%', overflowX: 'auto' }}>
          <Box sx={{ flex: isCompactLoadedLayout ? '0 0 auto' : 1, minHeight: 0, minWidth: 0, display: 'flex', width: '100%' }}>
            <MaterialReactTable table={table} />
          </Box>
        </Box>
      </Stack>
    </Box>
  );
}

export function NetworkDetailsFrequenciesTable(props: NetworkDetailsFrequenciesTableProps) {
  return <NetworkDetailsFrequenciesTableContent {...props} />;
}
