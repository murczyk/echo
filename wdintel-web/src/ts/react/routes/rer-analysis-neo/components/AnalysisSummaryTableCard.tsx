import DownloadIcon from '@mui/icons-material/Download';
import EditIcon from '@mui/icons-material/Edit';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import MapIcon from '@mui/icons-material/Map';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  type SxProps,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import type { Theme } from '@mui/material/styles';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { Fragment, memo, useCallback, useEffect, useId, useMemo, useState } from 'react';

import type { CallsignInfoRes, Network, SummaryTableFreqRow, Unit } from '../../../../../Bindings';
import { MrtRowActionButton, MrtRowActions, mrtRowActionsColumnSize } from '../../../components/MrtRowActionButton';
import { PowerChip } from '../../../components/PowerChip';
import { STANDARD_DIALOG_ACTIONS_SX, STANDARD_DIALOG_FORM_STACK_SX } from '../../../components/dialogStyles';
import { FULL_WIDTH_TABLE_PAPER_SX, getPageScrollTableContainerSx } from '../../../components/mui-customized/table/custom-styles';
import { buildDefaultColumnOrder, getDefaultMRTOptions, renderColumnActionsMenuItems } from '../../../components/mui-customized/table/get-default-table-options';
import { InternalTableActions } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { TableToolbarControls } from '../../../components/TableToolbarControls';
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
import { TableStateProvider, useTableStateContext } from '../../../components/mui-customized/table/table-state-provider';
import { buildAnalysisSummaryTableRows, type AnalysisSummaryTableRowView } from './analysis-summary-table-rows';

type Props = {
  callsignInfoMap: Record<string, CallsignInfoRes>;
  networkDisplayMap: Record<number, string>;
  networks: Network[];
  loading?: boolean;
  onDownloadGeojson: () => void;
  onDownloadKmz: () => void;
  onDownloadXlsx: () => void;
  onRenameUnit: (freq: string, unit: string, unitNew: string) => Promise<void>;
  onSelectFreq: (freq: string) => void;
  onShowFreqOnMap: (freq: string) => void;
  rows: SummaryTableFreqRow[];
  sx?: SxProps<Theme>;
  tableContainerSx?: SxProps<Theme>;
  title?: string;
  unitsMap: Record<number, Unit>;
};

type RenameDialogState = {
  freq: string;
  units: string[];
  selectedUnit: string;
};

const defaultMRTOptions = getDefaultMRTOptions<AnalysisSummaryTableRowView>();

export const DEFAULT_ANALYSIS_SUMMARY_TABLE_COLUMN_VISIBILITY = {
  freq: true,
  count: true,
  coordinateLabels: true,
  callsignSearchText: true,
  unitSearchText: true,
  locationSearchText: true,
};

export const DEFAULT_ANALYSIS_SUMMARY_TABLE_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: ['freq', 'count', 'coordinateLabels', 'callsignSearchText', 'unitSearchText', 'locationSearchText'],
  withRowNumbers: true,
  withRowActions: true,
});

function mergeSx(sx?: SxProps<Theme>): SxProps<Theme>[] {
  if (Array.isArray(sx)) return sx;
  return sx ? [sx] : [];
}

function CompactListCell({
  items,
  maxVisible = 3,
}: {
  items: string[];
  maxVisible?: number;
}) {
  if (items.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }

  const visibleItems = items.slice(0, maxVisible);
  const hiddenCount = items.length - visibleItems.length;

  return (
    <Stack spacing={0.5}>
      {visibleItems.map((item, index) => (
        <Typography key={`${item}-${index}`} variant="body2" title={item} sx={{ lineHeight: 1.35 }}>
          {item}
        </Typography>
      ))}
      {hiddenCount > 0 ? (
        <Typography variant="caption" color="text.secondary">
          +{hiddenCount} ще
        </Typography>
      ) : null}
    </Stack>
  );
}

function AnalysisSummaryTableCardInner({
  callsignInfoMap,
  networkDisplayMap,
  networks,
  loading = false,
  onDownloadGeojson,
  onDownloadKmz,
  onDownloadXlsx,
  onRenameUnit,
  onSelectFreq,
  onShowFreqOnMap,
  rows,
  sx,
  tableContainerSx,
  unitsMap,
}: Props) {
  const headingId = useId().replace(/:/g, '-');
  const tableStateContext = useTableStateContext();
  const [renameDialog, setRenameDialog] = useState<RenameDialogState | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);

  const data = useMemo(
    () =>
      buildAnalysisSummaryTableRows({
        rows,
        networks,
        networkDisplayMap,
        unitsMap,
        callsignInfoMap,
      }),
    [callsignInfoMap, networkDisplayMap, networks, rows, unitsMap],
  );

  useEffect(() => {
    if (!renameDialog) {
      setRenameValue('');
      return;
    }

    setRenameValue(renameDialog.selectedUnit);
  }, [renameDialog]);

  const closeRenameDialog = useCallback(() => {
    if (renameSaving) return;
    setRenameDialog(null);
  }, [renameSaving]);

  const openRenameDialog = useCallback((row: AnalysisSummaryTableRowView) => {
    if (row.editableUnits.length === 0) return;

    setRenameDialog({
      freq: row.freq,
      units: row.editableUnits,
      selectedUnit: row.editableUnits[0],
    });
  }, []);

  const saveRename = useCallback(async () => {
    if (!renameDialog) return;

    const nextValue = renameValue.trim();
    if (!nextValue || nextValue === renameDialog.selectedUnit) {
      setRenameDialog(null);
      return;
    }

    setRenameSaving(true);
    try {
      await onRenameUnit(renameDialog.freq, renameDialog.selectedUnit, nextValue);
      setRenameDialog(null);
    } finally {
      setRenameSaving(false);
    }
  }, [onRenameUnit, renameDialog, renameValue]);

  const columns = useMemo<MRT_ColumnDef<AnalysisSummaryTableRowView>[]>(
    () => [
      {
        header: 'Частота',
        accessorKey: 'freq',
        id: 'freq',
        size: 150,
        grow: false,
        enableSorting: true,
        Cell: ({ row }) => (
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {row.original.freq}
          </Typography>
        ),
      },
      {
        header: 'К-сть',
        accessorKey: 'count',
        id: 'count',
        size: 84,
        grow: false,
        enableSorting: true,
        muiTableHeadCellProps: { align: 'right' },
        muiTableBodyCellProps: { align: 'right' },
      },
      {
        header: 'Координати',
        accessorFn: (row) => row.coordinateLabels.join(' '),
        id: 'coordinateLabels',
        size: 180,
        Cell: ({ row }) => <CompactListCell items={row.original.coordinateLabels} />,
      },
      {
        header: 'Позивні',
        accessorFn: (row) => row.callsignChips.map((entry) => entry.callsign).join(' '),
        id: 'callsignSearchText',
        size: 320,
        Cell: ({ row }) => (
          <Stack direction="row" gap={0.5} flexWrap="wrap">
            {row.original.callsignChips.length === 0
              ? '—'
              : row.original.callsignChips.map((entry, index) => {
                  const chip = (
                    <PowerChip
                      label={
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          {entry.tooltip && entry.iconClass ? <i className={`bi ${entry.iconClass}`} /> : null}
                          <span>{entry.callsign.toUpperCase()}</span>
                        </span>
                      }
                      size="small"
                      color={entry.tooltip ? 'primary' : 'default'}
                      selected={entry.isHighlighted}
                    />
                  );

                  return entry.tooltip ? (
                    <Tooltip key={`${row.original.freq}-${entry.callsign}-${index}`} title={entry.tooltip} placement="top">
                      <span>{chip}</span>
                    </Tooltip>
                  ) : (
                    <Fragment key={`${row.original.freq}-${entry.callsign}-${index}`}>{chip}</Fragment>
                  );
                })}
          </Stack>
        ),
      },
      {
        header: 'Підрозділи',
        accessorFn: (row) => row.unitLabels.join(' '),
        id: 'unitSearchText',
        size: 320,
        Cell: ({ row }) => <CompactListCell items={row.original.unitLabels} maxVisible={4} />,
      },
      {
        header: 'Локації',
        accessorFn: (row) => row.locationLabels.join(' '),
        id: 'locationSearchText',
        size: 220,
        Cell: ({ row }) => <CompactListCell items={row.original.locationLabels} />,
      },
    ],
    [],
  );

  const paperSx = useMemo<SxProps<Theme>>(
    () => [{ p: 2, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 2 }, ...mergeSx(sx)] as SxProps<Theme>,
    [sx],
  );
  const outerTableContainerSx = useMemo<SxProps<Theme>>(
    () =>
      [
        {
          position: 'relative',
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'auto',
          borderTop: '1px solid',
          borderLeft: '1px solid',
          borderColor: 'var(--bs-border-color)',
          backgroundColor: 'var(--bs-body-bg)',
          '& .MuiTableHead-root': {
            position: 'sticky !important',
            top: '0 !important',
            zIndex: '4 !important',
            backgroundColor: 'var(--bs-body-bg) !important',
          },
          '& .MuiTableHead-root .MuiTableRow-root': {
            backgroundColor: 'inherit !important',
            borderBottom: '1px solid',
            borderColor: 'var(--bs-border-color)',
          },
          '& .MuiTableHead-root .MuiTableCell-head': {
            backgroundColor: 'inherit !important',
            borderBottom: '0 !important',
          },
          '& .MuiTable-root': {
            width: '100%',
          },
        },
        ...mergeSx(tableContainerSx),
      ] as SxProps<Theme>,
    [tableContainerSx],
  );
  const mrtContainerSx = useMemo<SxProps<Theme>>(
    () =>
      getPageScrollTableContainerSx({
        height: '100%',
        minHeight: 0,
        maxHeight: '100%',
      }) as SxProps<Theme>,
    [],
  );

  const table = useMaterialReactTable({
    columns,
    data,
    ...defaultMRTOptions,
    getRowId: (row) => row.freq,
    enableSorting: true,
    enableSortingRemoval: false,
    enablePagination: false,
    enableBottomToolbar: false,
    enableTopToolbar: false,
    enableColumnActions: true,
    enableColumnFilters: false,
    enableColumnFilterModes: false,
    enableFacetedValues: false,
    enableDensityToggle: false,
    enableGlobalFilter: true,
    enableHiding: true,
    enableFullScreenToggle: false,
    enableRowActions: true,
    enableRowNumbers: true,
    enableRowVirtualization: data.length > 100,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    positionActionsColumn: 'last',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    onSortingChange: tableStateContext.onSortingChange,
    renderRowActions: ({ row }) => (
      <Box sx={{ display: 'flex', justifyContent: 'center' }}>
        <MrtRowActions>
          <MrtRowActionButton
            label="У фільтр"
            onClick={() => onSelectFreq(row.original.freq)}
            icon={<FilterAltIcon fontSize="small" />}
          />
          <MrtRowActionButton
            label="На мапі"
            onClick={() => onShowFreqOnMap(row.original.freq)}
            icon={<MapIcon fontSize="small" />}
          />
          <MrtRowActionButton
            label="Редагувати підрозділ"
            onClick={() => openRenameDialog(row.original)}
            disabled={row.original.editableUnits.length === 0}
            icon={<EditIcon fontSize="small" />}
          />
        </MrtRowActions>
      </Box>
    ),
    defaultColumn: {
      size: 180,
      renderColumnActionsMenuItems,
    },
    initialState: {
      density: 'compact',
      sorting: [{ id: 'count', desc: true }],
      showGlobalFilter: true,
    },
    displayColumnDefOptions: {
      ...defaultMRTOptions.displayColumnDefOptions,
      'mrt-row-actions': {
        ...(defaultMRTOptions.displayColumnDefOptions?.['mrt-row-actions'] ?? {}),
        size: mrtRowActionsColumnSize(3),
        minSize: mrtRowActionsColumnSize(3),
        maxSize: mrtRowActionsColumnSize(3),
        header: 'Дії',
        enableHiding: false,
      },
    },
    muiTablePaperProps: {
      sx: FULL_WIDTH_TABLE_PAPER_SX,
      style: {
        padding: 0,
      },
    },
    muiTableContainerProps: {
      sx: mrtContainerSx,
    },
    muiTableProps: {
      'aria-label': 'Таблиця частот аналізу',
    },
    state: {
      showAlertBanner: false,
      showLoadingOverlay: false,
      density: tableStateContext.density,
      columnVisibility: tableStateContext.columnVisibility,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
      globalFilter: tableStateContext.globalFilter,
      sorting: tableStateContext.sorting,
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table, tableStateContext]);

  return (
    <Paper variant="outlined" component="section" aria-labelledby={headingId} sx={paperSx}>
      <TableToolbarControls
        withGlobalTextFilter
        trailingActions={
          <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Button startIcon={<DownloadIcon />} onClick={onDownloadXlsx} variant="outlined" aria-label="XLSX" title="XLSX">
              XLSX
            </Button>
            <Button startIcon={<DownloadIcon />} onClick={onDownloadKmz} variant="outlined" aria-label="KMZ" title="KMZ">
              KMZ
            </Button>
            <Button startIcon={<DownloadIcon />} onClick={onDownloadGeojson} variant="outlined" aria-label="GEOJSON" title="GEOJSON">
              GEOJSON
            </Button>
            <InternalTableActions
              table={table}
              filtersHidden
              rowNumberAppearanceControl
            />
          </Stack>
        }
      />

      <Box sx={outerTableContainerSx}>
        <Box sx={{ position: 'relative', minHeight: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
          <MaterialReactTable table={table} />
          {loading ? (
            <SectionLoadingOverlay open ariaLabel="Оновлення таблиці частот" sx={{ zIndex: 2 }} />
          ) : null}
        </Box>
      </Box>

      <Dialog open={renameDialog != null} onClose={closeRenameDialog}>
        <DialogTitle>Редагувати підрозділ</DialogTitle>
        <DialogContent>
          <Stack sx={STANDARD_DIALOG_FORM_STACK_SX}>
            <Typography variant="body2" color="text.secondary">
              {renameDialog ? `Частота ${renameDialog.freq}` : ''}
            </Typography>
            <FormControl size="small" fullWidth disabled={renameSaving}>
              <InputLabel id={`${headingId}-rename-unit-label`}>Підрозділ</InputLabel>
              <Select
                labelId={`${headingId}-rename-unit-label`}
                label="Підрозділ"
                value={renameDialog?.selectedUnit ?? ''}
                onChange={(event) => {
                  const selectedUnit = String(event.target.value);
                  setRenameDialog((current) => (current ? { ...current, selectedUnit } : current));
                  setRenameValue(selectedUnit);
                }}
              >
                {(renameDialog?.units ?? []).map((unit, index) => (
                  <MenuItem key={`${unit}-${index}`} value={unit}>
                    {unit}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              autoFocus
              size="small"
              fullWidth
              label="Нова назва"
              value={renameValue}
              disabled={renameSaving}
              onChange={(event) => setRenameValue(event.target.value)}
              aria-label={renameDialog ? `Нова назва підрозділу для частоти ${renameDialog.freq}` : 'Нова назва підрозділу'}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
          <Button onClick={closeRenameDialog} disabled={renameSaving}>
            Скасувати
          </Button>
          <Button variant="contained" onClick={() => void saveRename()} disabled={renameDialog == null || renameSaving || renameValue.trim() === ''}>
            Зберегти
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
}

export const AnalysisSummaryTableCard = memo(function AnalysisSummaryTableCard(props: Props) {
  return (
    <TableStateProvider
      tableId="rer-analysis-summary-table"
      defaultColumnVisibility={DEFAULT_ANALYSIS_SUMMARY_TABLE_COLUMN_VISIBILITY}
      defaultColumnOrder={DEFAULT_ANALYSIS_SUMMARY_TABLE_COLUMN_ORDER}
      defaultEnableColumnOrdering={false}
    >
      <AnalysisSummaryTableCardInner {...props} />
    </TableStateProvider>
  );
});
