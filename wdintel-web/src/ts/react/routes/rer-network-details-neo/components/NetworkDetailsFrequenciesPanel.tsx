import BuildIcon from '@mui/icons-material/Build';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import {
  Box,
  Button,
  Chip,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  Typography,
} from '@mui/material';
import { MaterialReactTable, useMaterialReactTable, type MRT_ColumnDef } from 'material-react-table';
import { useEffect, useMemo } from 'react';

import type { ModulationRec, Network, NetworkFreqsRes } from '../../../../../Bindings';
import { MrtRowActionButton, mrtRowActionsColumnSize } from '../../../components/MrtRowActionButton';
import { TableEmptyState } from '../../../components/TableEmptyState';
import {
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../../components/mui-customized/table/custom-styles';
import {
  buildDefaultColumnOrder,
  buildExplicitSingleSelectColumnFilter,
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
  withExplicitSelectAllOption,
} from '../../../components/mui-customized/table/get-default-table-options';
import { InternalTableActions } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { PowerChip } from '../../../components/PowerChip';
import { TableStateProvider, useTableStateContext } from '../../../components/mui-customized/table/table-state-provider';
import { formatDateTime24 } from '../../../utils/misc';
import { buildNetworkFreqRows, type NetworkFreqTableRow } from '../frequency-utils';

const defaultMRTOptions = getDefaultMRTOptions<NetworkFreqTableRow>();

const STATUS_FILTER_OPTIONS = withExplicitSelectAllOption([
  { text: 'Активні', value: 'active' },
  { text: 'Неактивні', value: 'inactive' },
]);

type StatusFilterValue = 'Усі' | 'active' | 'inactive';

const DEFAULT_COLUMNS_VISIBILITY = {
  displayFreq: true,
  typeLabel: true,
  encryptionLabel: true,
  messageCount: true,
  callsignLabel: true,
  lastDatetime: true,
  status: true,
};

const DEFAULT_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: ['displayFreq', 'typeLabel', 'encryptionLabel', 'messageCount', 'callsignLabel', 'lastDatetime', 'status'],
  withRowNumbers: true,
  withRowActions: true,
});

const COMPACT_LOADED_ROW_LIMIT = 8;

const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

function formatStatusLabel(isActive: boolean): string {
  return isActive ? 'Активна' : 'Неактивна';
}

function renderStatusChip(isActive: boolean) {
  return (
    <Chip
      size="small"
      label={formatStatusLabel(isActive)}
      sx={{
        height: 22,
        fontSize: '0.75rem',
        fontWeight: 600,
        bgcolor: isActive ? 'success.main' : 'warning.main',
        color: isActive ? 'success.contrastText' : 'warning.contrastText',
        '& .MuiChip-label': { px: 0.9 },
      }}
    />
  );
}

function renderFrequencyCell(
  row: NetworkFreqTableRow,
) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ minWidth: 0, pl: row.kind === 'freq' && row.parentGroupId ? 4.5 : 0 }}
    >
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

function getRowIsActive(row: NetworkFreqTableRow): boolean {
  return row.kind === 'group' ? row.isActive : row.freq.isActive;
}

function resolveStatusFilterValue(value: unknown): StatusFilterValue {
  if (value === 'active' || value === 'inactive' || value === 'Усі') {
    return value;
  }

  return 'Усі';
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
  }));
}

type Props = {
  network: Network | null;
  loading: boolean;
  freqs: NetworkFreqsRes[];
  freqsLoaded: boolean;
  freqsLoading: boolean;
  freqsError: string | null;
  modulations: ModulationRec[];
  expandedFrequencyGroupIds: string[];
  onToggleFrequencyGroupExpanded: (groupId: string) => void;
  onOpenFreqCreateWizard: () => void;
  onOpenFreqEditDrawer: (freq: NetworkFreqsRes) => void;
  onOpenFreqTechDrawer: (freq: NetworkFreqsRes) => void;
  onOpenDeleteFreqDialog: (freq: NetworkFreqsRes) => void;
  onOpenFreqRowActions: (anchorEl: HTMLElement, freqId: number) => void;
  onCloseFreqRowActions: () => void;
  freqRowActionMenuAnchorEl: HTMLElement | null;
  freqRowActionTargetId: number | null;
  canManage: boolean;
  onReloadFrequencies: () => void;
};

function buildColumns(): MRT_ColumnDef<NetworkFreqTableRow>[] {
  return [
    {
      header: 'Частота',
      accessorKey: 'displayFreq',
      id: 'displayFreq',
      size: 280,
      Cell: ({ row }) => renderFrequencyCell(row.original),
    },
    {
      header: 'Тип',
      accessorKey: 'typeLabel',
      id: 'typeLabel',
      size: 120,
    },
    {
      header: 'Шифрування',
      accessorKey: 'encryptionLabel',
      id: 'encryptionLabel',
      size: 180,
    },
    {
      header: 'К-сть',
      accessorKey: 'messageCount',
      id: 'messageCount',
      size: 110,
      Cell: ({ row }) => <Typography variant="body2" fontWeight={700}>{getRowMessageCount(row.original)}</Typography>,
    },
    {
      header: 'Позивні',
      accessorKey: 'callsignLabel',
      id: 'callsignLabel',
      size: 300,
      Cell: ({ row }) => {
        const label = getRowCallsignLabel(row.original);
        return (
          <Typography variant="body2" title={label} sx={{ maxWidth: '100%' }} noWrap>
            {label}
          </Typography>
        );
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
    {
      header: 'Статус',
      accessorFn: (row) => (getRowIsActive(row) ? 'active' : 'inactive'),
      id: 'status',
      size: 130,
      filterVariant: 'select',
      filterSelectOptions: STATUS_FILTER_OPTIONS,
      meta: {
        activeFilterDefaultValue: 'Усі',
      },
      Filter: buildExplicitSingleSelectColumnFilter({
        options: STATUS_FILTER_OPTIONS,
        fallbackValue: 'Усі',
        onChange: (column, nextValue) => column.setFilterValue(nextValue === 'Усі' ? undefined : nextValue),
      }),
      filterFn: (row, columnId, filterValue) => {
        const value = String(filterValue ?? 'Усі');
        if (value === 'Усі') return true;
        return String(row.getValue(columnId)) === value;
      },
      Cell: ({ row }) => renderStatusChip(getRowIsActive(row.original)),
    },
  ];
}

function NetworkDetailsFrequenciesPanelContent({
  network,
  loading,
  freqs,
  freqsLoaded,
  freqsLoading,
  freqsError,
  modulations,
  expandedFrequencyGroupIds,
  onToggleFrequencyGroupExpanded,
  onOpenFreqCreateWizard,
  onOpenFreqEditDrawer,
  onOpenFreqTechDrawer,
  onOpenDeleteFreqDialog,
  onOpenFreqRowActions,
  onCloseFreqRowActions,
  freqRowActionMenuAnchorEl,
  freqRowActionTargetId,
  canManage,
  onReloadFrequencies,
}: Props) {
  const tableStateContext = useTableStateContext();
  const modulationsById = useMemo(() => new Map(modulations.map((modulation) => [modulation.id, modulation.name])), [modulations]);
  const rows = useMemo(() => buildNetworkFreqRows(freqs, modulationsById, expandedFrequencyGroupIds), [
    expandedFrequencyGroupIds,
    freqs,
    modulationsById,
  ]);
  const loadingRows = useMemo(() => buildLoadingRows(), []);
  const activeRow = useMemo(
    () => rows.find((row) => row.kind === 'freq' && row.freq.networkFreqId === freqRowActionTargetId) ?? null,
    [freqRowActionTargetId, rows],
  );
  const activeFreq = activeRow && activeRow.kind === 'freq' ? activeRow.freq : null;
  const isInitialLoading = loading || (freqsLoading && !freqsLoaded);
  const isCompactLoadedLayout = !isInitialLoading && rows.length <= COMPACT_LOADED_ROW_LIMIT;
  const hasActiveFilters = tableStateContext.columnFilters.length > 0 || Boolean(tableStateContext.globalFilter);
  const statusFilterValue = useMemo(() => {
    const currentFilter = tableStateContext.columnFilters.find((filter) => filter.id === 'status')?.value;
    return resolveStatusFilterValue(currentFilter);
  }, [tableStateContext.columnFilters]);
  const statusFilterChips = (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <PowerChip
        label="Усі"
        selected={statusFilterValue === 'Усі'}
        onClick={() => setStatusFilterValue('Усі')}
        interactive
        fontSize="0.75rem"
        fontWeight={600}
        labelPaddingX={0.85}
        labelPaddingY={0.1}
        sx={{ height: 28, lineHeight: 1 }}
      />
      <PowerChip
        label="Активні"
        selected={statusFilterValue === 'active'}
        onClick={() => setStatusFilterValue('active')}
        interactive
        fontSize="0.75rem"
        fontWeight={600}
        labelPaddingX={0.85}
        labelPaddingY={0.1}
        sx={{ height: 28, lineHeight: 1 }}
      />
      <PowerChip
        label="Неактивні"
        selected={statusFilterValue === 'inactive'}
        onClick={() => setStatusFilterValue('inactive')}
        interactive
        fontSize="0.75rem"
        fontWeight={600}
        labelPaddingX={0.85}
        labelPaddingY={0.1}
        sx={{ height: 28, lineHeight: 1 }}
      />
    </Stack>
  );

  function setStatusFilterValue(nextValue: StatusFilterValue) {
    const nextFilters = tableStateContext.columnFilters.filter((filter) => filter.id !== 'status');
    if (nextValue !== 'Усі') {
      nextFilters.push({ id: 'status', value: nextValue });
    }

    tableStateContext.onColumnFiltersChange(nextFilters);
  }

  const columns = useMemo(() => buildColumns(), []);

  const table = useMaterialReactTable({
    columns,
    data: isInitialLoading && rows.length === 0 ? loadingRows : rows,
    ...defaultMRTOptions,
    layoutMode: 'grid',
    enablePagination: false,
    enableBottomToolbar: false,
    enableTopToolbar: false,
    enableColumnActions: true,
    enableColumnFilters: true,
    enableColumnFilterModes: false,
    enableFacetedValues: true,
    enableHiding: true,
    enableSorting: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    enableRowVirtualization: false,
    enableRowSelection: false,
    enableRowNumbers: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    columnFilterDisplayMode: 'popover',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
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
    defaultColumn: {
      size: 180,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: mrtRowActionsColumnSize(2),
      },
    },
    muiTablePaperProps: ({ table }) => ({
      ...resolvedPaperProps({ table }),
      sx: {
        ...(resolvedPaperProps({ table }) as { sx?: object }).sx,
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
          ? {
              flex: '0 0 auto',
              minHeight: 0,
              height: 'auto',
              maxHeight: 'none',
              overflowX: 'auto',
              overflowY: 'visible',
              WebkitOverflowScrolling: 'touch',
            }
          : getPageScrollTableContainerSx({
              loading: freqsLoading,
              height: '100%',
              minHeight: 0,
              maxHeight: table.getState().isFullScreen ? '100%' : 'none',
              idleOverflow: 'auto',
            })),
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        height: isCompactLoadedLayout ? 'auto' : '100%',
      },
    }),
    muiTableBodyRowProps: ({ row }) => ({
      hover: true,
      sx: {
        opacity: row.original.kind === 'freq' && row.original.parentGroupId ? 0.96 : 1,
      },
    }),
    renderEmptyRowsFallback: () => (
      <Box sx={{ py: 6 }}>
        <TableEmptyState
          message={freqsError ? 'Не вдалося завантажити частоти' : hasActiveFilters ? 'Немає частот за обраними фільтрами' : 'Частоти відсутні'}
          actionLabel={hasActiveFilters ? 'Скинути фільтри' : undefined}
          onAction={
            hasActiveFilters
              ? () => {
                  tableStateContext.onColumnFiltersChange([]);
                  tableStateContext.onChangeGlobalFilter('');
                }
              : undefined
          }
        />
      </Box>
    ),
    localization: {
      ...defaultMRTOptions.localization,
    },
    manualFiltering: false,
    initialState: {
      density: 'comfortable',
      columnOrder: DEFAULT_COLUMN_ORDER,
      columnVisibility: DEFAULT_COLUMNS_VISIBILITY,
    },
    getRowId: (row) => row.id,
    renderRowActions: ({ row }) => {
      if (isInitialLoading) {
        return <Box sx={{ minHeight: 28 }} />;
      }

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

      if (!canManage) {
        return <Box sx={{ minHeight: 28 }} />;
      }

      const freqRow = row.original.freq;
      return (
        <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="center" useFlexGap>
          <MrtRowActionButton
            label="Редагувати частоту"
            onClick={() => onOpenFreqEditDrawer(freqRow)}
            icon={<EditIcon fontSize="small" />}
          />
          <IconButton
            size="small"
            aria-label="Дії з частотою"
            onClick={(event) => {
              event.stopPropagation();
              onOpenFreqRowActions(event.currentTarget, freqRow.networkFreqId);
            }}
          >
            <MoreVertOutlinedIcon fontSize="small" />
          </IconButton>
        </Stack>
      );
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table, tableStateContext]);

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', width: '100%' }}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          px: 0,
          pt: 0,
          mb: 1.5,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, width: '100%', minWidth: 0 }}>
          <Typography variant="h6">Частоти</Typography>
          {canManage ? (
            <Button variant="contained" onClick={onOpenFreqCreateWizard} disabled={!network || freqsLoading}>
              Додати
            </Button>
          ) : null}
        </Box>
        {freqsError ? (
          <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Typography variant="body2" color="error">
              {freqsError}
            </Typography>
            <Button size="small" onClick={() => onReloadFrequencies()} disabled={freqsLoading}>
              Спробувати ще раз
            </Button>
          </Stack>
        ) : null}
      </Box>

      <Stack spacing={1.25} sx={{ minHeight: 0, minWidth: 0, flex: isCompactLoadedLayout ? '0 0 auto' : 1, width: '100%' }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            width: '100%',
            minWidth: 0,
          }}
        >
          <Box sx={{ minWidth: 0 }}>{statusFilterChips}</Box>
          <Box sx={{ flexShrink: 0 }}>
            <InternalTableActions table={table} />
          </Box>
        </Box>

        <Box sx={{ flex: isCompactLoadedLayout ? '0 0 auto' : 1, minHeight: 0, minWidth: 0, display: 'flex', width: '100%', overflowX: 'auto' }}>
          <Box sx={{ flex: isCompactLoadedLayout ? '0 0 auto' : 1, minHeight: 0, minWidth: 0, display: 'flex', width: '100%' }}>
            <MaterialReactTable table={table} />
          </Box>
        </Box>
      </Stack>

      <Menu
        anchorEl={freqRowActionMenuAnchorEl}
        open={freqRowActionMenuAnchorEl !== null && activeFreq !== null}
        onClose={onCloseFreqRowActions}
        slotProps={{ paper: { sx: { minWidth: 260 } } }}
      >
        {activeFreq ? (
          [
            <MenuItem
              key="tech"
              onClick={() => {
                onCloseFreqRowActions();
                onOpenFreqTechDrawer(activeFreq);
              }}
            >
              <ListItemIcon>
                <BuildIcon fontSize="small" />
              </ListItemIcon>
              Редагувати тех. дані
            </MenuItem>,
            <MenuItem
              key="delete"
              onClick={() => {
                onCloseFreqRowActions();
                onOpenDeleteFreqDialog(activeFreq);
              }}
              sx={{ color: 'error.main' }}
            >
              <ListItemIcon sx={{ color: 'error.main' }}>
                <DeleteIcon fontSize="small" />
              </ListItemIcon>
              Видалити частоту
            </MenuItem>,
          ]
        ) : (
          <MenuItem disabled>Немає дій</MenuItem>
        )}
      </Menu>
    </Box>
  );
}

export function NetworkDetailsFrequenciesPanel(props: Props) {
  return (
    <TableStateProvider
      tableId="network-details-frequencies"
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
    >
      <NetworkDetailsFrequenciesPanelContent {...props} />
    </TableStateProvider>
  );
}
