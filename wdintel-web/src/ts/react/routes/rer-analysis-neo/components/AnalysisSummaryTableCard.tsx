import DownloadIcon from '@mui/icons-material/Download';
import { isNullOrUndefined, isPresent } from '../../../utils/misc';
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
  Stack,
  TextField,
  type SxProps,
} from '@mui/material';
import type { Theme } from '@mui/material/styles';
import { MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { memo, useCallback, useEffect, useId, useMemo, useState } from 'react';

import type { CallsignInfoRes, Network, SummaryTableFreqRow, Unit } from '../../../../../Bindings';
import { STANDARD_DIALOG_ACTIONS_SX, STANDARD_DIALOG_FORM_STACK_SX } from '../../../components/dialogStyles';
import {
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../../components/mui-customized/table/custom-styles';
import { getDefaultMRTOptions, renderColumnActionsMenuItems } from '../../../components/mui-customized/table/get-default-table-options';
import { InternalTableActions } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { TableStateProvider, useTableStateContext } from '../../../components/mui-customized/table/table-state-provider';
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
import { TableEmptyState } from '../../../components/TableEmptyState';
import { TableToolbarControls } from '../../../components/TableToolbarControls';
import { MRT_ROW_ACTION_MODAL_PROPS } from '../../../components/MrtRowActionButton';
import {
  buildAnalysisSummaryTableColumns,
  DEFAULT_ANALYSIS_SUMMARY_TABLE_COLUMN_ORDER,
  DEFAULT_ANALYSIS_SUMMARY_TABLE_COLUMN_VISIBILITY,
  DEFAULT_ANALYSIS_SUMMARY_TABLE_SORTING,
} from './analysis-summary-table-columns';
import { SummaryTableLoadingState } from './analysis-summary-table-cells';
import { buildAnalysisSummaryTableRows, type AnalysisSummaryTableRowView } from './analysis-summary-table-rows';

type Props = {
  callsignInfoMap: Record<string, CallsignInfoRes>;
  networkDisplayMap: Record<number, string>;
  networks: Network[];
  loaded?: boolean;
  loading?: boolean;
  onDownloadXlsx: () => void;
  onRenameUnit: (freq: string, unit: string, unitNew: string) => Promise<void>;
  onSelectFreq: (freq: string) => void;
  onShowFreqOnMap: (freq: string) => void;
  rows: SummaryTableFreqRow[];
  sx?: SxProps<Theme>;
  tableContainerSx?: SxProps<Theme>;
  sidebarMode?: boolean;
  title?: string;
  unitsMap: Record<number, Unit>;
};

type RenameDialogState = {
  freq: string;
  units: string[];
  selectedUnit: string;
};

const defaultMRTOptions = getDefaultMRTOptions<AnalysisSummaryTableRowView>();

function mergeSx(sx?: SxProps<Theme>): SxProps<Theme>[] {
  if (Array.isArray(sx)) return sx;
  return sx ? [sx] : [];
}

function AnalysisSummaryTableCardInner({
  callsignInfoMap,
  networkDisplayMap,
  networks,
  loaded,
  loading = false,
  onDownloadXlsx,
  onRenameUnit,
  onSelectFreq,
  onShowFreqOnMap,
  rows,
  sx,
  tableContainerSx,
  sidebarMode = false,
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
  const resolvedLoaded = loaded ?? !loading;
  const showInitialSkeleton = !resolvedLoaded && data.length === 0;
  const showEmptyState = resolvedLoaded && !loading && data.length === 0;
  const loadingVisible = loading && !showInitialSkeleton;

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

  const columns = useMemo(
    () =>
      buildAnalysisSummaryTableColumns({
        onRenameUnit: openRenameDialog,
        onSelectFreq,
        onShowFreqOnMap,
      }),
    [onSelectFreq, onShowFreqOnMap, openRenameDialog],
  );

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

  const paperSx = useMemo<SxProps<Theme>>(
    () =>
      [
        {
          p: sidebarMode ? 1 : 2,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: sidebarMode ? 1 : 2,
        },
        ...mergeSx(sx),
      ] as SxProps<Theme>,
    [sidebarMode, sx],
  );

  const outerTableContainerSx = useMemo<SxProps<Theme>>(
    () =>
      [
        {
          position: 'relative',
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          overflow: 'hidden',
          borderRight: '1px solid',
          borderBottom: '1px solid',
          borderTop: '1px solid',
          borderLeft: '1px solid',
          borderColor: 'var(--bs-border-color)',
          backgroundColor: 'var(--bs-body-bg)',
          '& .MuiTableHead-root': {
            position: 'sticky !important',
            top: '0 !important',
            zIndex: '4 !important',
            opacity: 1,
            backgroundColor: 'var(--bs-body-bg) !important',
            color: 'var(--bs-body-color) !important',
          },
          '& .MuiTableHead-root .MuiTableRow-root': {
            backgroundColor: 'var(--bs-body-bg) !important',
            color: 'var(--bs-body-color) !important',
            borderBottom: '1px solid',
            borderColor: 'var(--bs-border-color)',
          },
          '& .MuiTableHead-root .MuiTableCell-head': {
            backgroundColor: 'var(--bs-body-bg) !important',
            color: 'var(--bs-body-color) !important',
            borderBottom: '0 !important',
            opacity: 1,
          },
          '& .MuiTable-root': {
            width: 'max-content',
            minWidth: '100%',
          },
        },
        ...mergeSx(tableContainerSx),
      ] as SxProps<Theme>,
    [tableContainerSx],
  );

  const mrtContainerSx = useMemo<SxProps<Theme>>(
    () =>
      getPageScrollTableContainerSx({
        height: 'auto',
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
    enablePagination: true,
    enableBottomToolbar: true,
    enableTopToolbar: false,
    enableColumnActions: true,
    enableColumnFilters: false,
    enableColumnFilterModes: false,
    enableFacetedValues: false,
    enableDensityToggle: false,
    enableGlobalFilter: true,
    enableHiding: true,
    enableFullScreenToggle: false,
    enableRowActions: false,
    enableRowNumbers: true,
    enableRowVirtualization: data.length > 100,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    onSortingChange: tableStateContext.onSortingChange,
    defaultColumn: {
      size: sidebarMode ? 140 : 180,
      grow: 0,
      renderColumnActionsMenuItems,
      muiTableHeadCellProps: {
        sx: {
          ...((CUSTOM_STYLES.muiTableHeadCellProps as { sx?: object }).sx ?? {}),
          backgroundColor: 'var(--bs-body-bg)',
          color: 'var(--bs-body-color)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        },
      },
      muiTableBodyCellProps: {
        sx: {
          ...((CUSTOM_STYLES.muiTableBodyCellProps as { sx?: object }).sx ?? {}),
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        },
      },
    },
    initialState: {
      density: 'compact',
      sorting: DEFAULT_ANALYSIS_SUMMARY_TABLE_SORTING,
      showGlobalFilter: true,
      pagination: {
        pageIndex: 0,
        pageSize: 25,
      },
    },
    displayColumnDefOptions: {
      ...defaultMRTOptions.displayColumnDefOptions,
      ...CUSTOM_STYLES.displayColumnDefOptions,
    },
    muiTablePaperProps: {
      sx: {
        ...FULL_WIDTH_TABLE_PAPER_SX,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
      },
      style: {
        padding: 0,
      },
    },
    muiTableContainerProps: {
      sx: [
        ...mergeSx(mrtContainerSx),
        {
          flex: 1,
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
        },
      ] as SxProps<Theme>,
    },
    muiBottomToolbarProps: {
      sx: {
        flexShrink: 0,
        backgroundColor: 'var(--bs-body-bg)',
      },
    },
    muiPaginationProps: {
      rowsPerPageOptions: [25, 50, 100],
    },
    muiTableProps: {
      'aria-label': 'Таблиця частот аналізу',
      sx: {
        width: 'max-content',
        minWidth: '100%',
      },
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
        desktopBreakpoint={sidebarMode ? 'md' : 'lg'}
        leadingDesktopBreakpoint={sidebarMode ? 'md' : 'lg'}
        trailingActions={
          <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Button startIcon={<DownloadIcon />} onClick={onDownloadXlsx} variant="outlined" aria-label="XLSX" title="XLSX">
              XLSX
            </Button>
            <InternalTableActions table={table} filtersHidden rowNumberAppearanceControl />
          </Stack>
        }
      />

      <Box sx={outerTableContainerSx}>
        <Box sx={{ position: 'relative', minHeight: '100%', height: '100%', display: 'flex', flexDirection: 'column', minWidth: '100%' }}>
          {showInitialSkeleton ? (
            <SummaryTableLoadingState />
          ) : showEmptyState ? (
            <Box sx={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <TableEmptyState message="Частоти за обраними параметрами відсутні" />
            </Box>
          ) : (
            <MaterialReactTable table={table} />
          )}
          {loadingVisible ? (
            <SectionLoadingOverlay open ariaLabel="Оновлення таблиці частот" sx={{ zIndex: 2 }} />
          ) : null}
        </Box>
      </Box>

      <Dialog open={isPresent(renameDialog)} onClose={closeRenameDialog} disableRestoreFocus={MRT_ROW_ACTION_MODAL_PROPS.disableRestoreFocus}>
        <DialogTitle>Редагувати підрозділ</DialogTitle>
        <DialogContent>
          <Stack sx={STANDARD_DIALOG_FORM_STACK_SX}>
            <Box sx={{ color: 'text.secondary', fontSize: '0.875rem' }}>{renameDialog ? `Частота ${renameDialog.freq}` : ''}</Box>
            {renameDialog?.units.length === 1 ? null : (
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
            )}
            <TextField
              autoFocus={renameDialog?.units.length === 1}
              size="small"
              fullWidth
              label={renameDialog?.units.length === 1 ? 'Поточна назва підрозділу' : 'Нова назва'}
              value={renameValue}
              disabled={renameSaving}
              onChange={(event) => setRenameValue(event.target.value)}
              aria-label={renameDialog ? `Назва підрозділу для частоти ${renameDialog.freq}` : 'Назва підрозділу'}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
          <Button onClick={closeRenameDialog} disabled={renameSaving}>
            Скасувати
          </Button>
          <Button variant="contained" onClick={() => void saveRename()} disabled={isNullOrUndefined(renameDialog) || renameSaving || renameValue.trim() === ''}>
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
      defaultSorting={DEFAULT_ANALYSIS_SUMMARY_TABLE_SORTING}
    >
      <AnalysisSummaryTableCardInner {...props} />
    </TableStateProvider>
  );
});
