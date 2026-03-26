import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ClearIcon from '@mui/icons-material/Clear';
import EditIcon from '@mui/icons-material/Edit';
import SettingsIcon from '@mui/icons-material/Settings';
import { Alert, Box, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, IconButton, InputAdornment, MenuItem, OutlinedInput, Select, SelectChangeEvent, Stack, Typography } from '@mui/material';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';

import { AorCoordinates, AreaOfResponsibility } from '../../../../Bindings';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../components/dialogStyles';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import { formatMrtCellTextValue } from '../../components/formatMrtCellTextValue';
import { MrtRowActionButton, MrtRowActions, mrtRowActionsColumnSize } from '../../components/MrtRowActionButton';
import { TableContentState } from '../../components/TableContentState';
import { Button } from '../../components/mui-customized/button';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { TableStateProvider, useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { listAors } from '../../services/api/aor';
import { listAorLocationConfigs, saveAorLocationConfig } from '../../services/api/location-config';
import { navigateWithinSpa, withBackTo } from '../../utils/browser';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

const DEFAULT_COLUMNS_VISIBILITY = {
  name: true,
  description: true,
  leftBound: true,
  rightBound: true,
  locationConfigs: true,
  coordinates: true,
  isTopLevel: true,
};

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'name',
  'description',
  'leftBound',
  'rightBound',
  'locationConfigs',
  'coordinates',
  'isTopLevel',
];

type AorRow = AreaOfResponsibility & {
  locationConfigs: string[];
};

type LocationConfigDialogState = {
  aorId: number;
  aorName: string;
  selectedConfigs: string[];
  isSaving: boolean;
  error: string | null;
};

const defaultMRTOptions = getDefaultMRTOptions<AorRow>();

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function buildEditHref(id: number): string {
  return withBackTo(`/admin/aor-neo/${id}`);
}

function buildCreateHref(): string {
  return withBackTo('/admin/aor-neo/new');
}

function formatCoords(coords: AorCoordinates | null): string {
  if (!coords) return '—';
  return `${coords.latitude}, ${coords.longitude}`;
}

function formatLocationConfigs(configs: string[] | null | undefined): string {
  if (!configs || configs.length === 0) return 'За замовчуванням (config.toml)';
  return configs.join(', ');
}

function buildAorRows(aors: AreaOfResponsibility[], locationConfigsByAorId: Map<number, string[]>): AorRow[] {
  return aors.map((aor) => ({
    ...aor,
    locationConfigs: locationConfigsByAorId.get(aor.id) ?? [],
  }));
}

function buildLocationConfigsByAorId(items: Awaited<ReturnType<typeof listAorLocationConfigs>>['items']): Map<number, string[]> {
  return new Map(items.map((item) => [item.aorId, item.selectedConfigs ?? []]));
}

function buildAorLoadingRows(): AorRow[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    id: -index - 1,
    name: '',
    description: null,
    leftBound: 0,
    rightBound: 0,
    leftCoordinates: null,
    rightCoordinates: null,
    isTopLevel: false,
    createdAt: 0,
    locationConfigs: [],
  }));
}

function useAorColumns(): MRT_ColumnDef<AorRow>[] {
  return useMemo(
    () => [
      {
        header: 'Назва',
        accessorFn: (row) => formatMrtCellTextValue(row.name),
        id: 'name',
        size: 220,
      },
      {
        header: 'Опис',
        accessorFn: (row) => formatMrtCellTextValue(row.description),
        id: 'description',
        size: 240,
      },
      {
        header: 'Ліва межа',
        accessorFn: (row) => (row.leftBound == null ? '—' : String(row.leftBound)),
        id: 'leftBound',
        size: 120,
      },
      {
        header: 'Права межа',
        accessorFn: (row) => (row.rightBound == null ? '—' : String(row.rightBound)),
        id: 'rightBound',
        size: 120,
      },
      {
        header: 'Конфігурація локацій',
        accessorFn: (row) => formatLocationConfigs(row.locationConfigs),
        id: 'locationConfigs',
        size: 260,
      },
      {
        header: 'Координати',
        accessorFn: (row) => `${formatCoords(row.leftCoordinates)} ${formatCoords(row.rightCoordinates)}`,
        id: 'coordinates',
        Cell: ({ row }) => (
          <div className="text-sm">
            <div>Ліва: {formatCoords(row.original.leftCoordinates)}</div>
            <div>Права: {formatCoords(row.original.rightCoordinates)}</div>
          </div>
        ),
        enableSorting: false,
        size: 240,
      },
      {
        header: 'Топ-рівень',
        accessorFn: (row) => (row.isTopLevel ? 1 : 0),
        id: 'isTopLevel',
        Cell: ({ row }) => (
          <div className="flex justify-center">
            {row.original.isTopLevel ? (
              <CheckCircleIcon className="text-green-600" fontSize="small" />
            ) : (
              <CancelIcon className="text-red-600" fontSize="small" />
            )}
          </div>
        ),
        size: 120,
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

type RowActionsProps = {
  aor: AorRow;
  onConfigure: (aor: AorRow) => void;
};

function RowActions(props: RowActionsProps) {
  return (
    <MrtRowActions>
      <MrtRowActionButton
        label="Редагувати"
        onClick={() => navigateWithinSpa(buildEditHref(props.aor.id))}
        icon={<EditIcon fontSize="small" />}
      />
      <MrtRowActionButton
        label="Налаштувати конфігурацію локацій"
        onClick={() => props.onConfigure(props.aor)}
        icon={<SettingsIcon fontSize="small" />}
      />
    </MrtRowActions>
  );
}

type AorTableProps = {
  data: AorRow[];
  loading: boolean;
  onConfigure: (aor: AorRow) => void;
};

function AorTable(props: AorTableProps) {
  const columns = useAorColumns();
  const tableStateContext = useTableStateContext();
  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

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

  const table = useMaterialReactTable<AorRow>({
    columns,
    data: props.loading ? buildAorLoadingRows() : props.data,
    ...defaultMRTOptions,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
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
    enableRowActions: !props.loading,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => <RowActions aor={row.original} onConfigure={props.onConfigure} />,
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: mrtRowActionsColumnSize(2),
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

function AdminAorNeoPageBody() {
  const [aors, setAors] = useState<AorRow[]>([]);
  const [loadStatus, setLoadStatus] = useState<LoadingStatus>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [availableLocationConfigs, setAvailableLocationConfigs] = useState<string[]>([]);
  const [locationConfigDialog, setLocationConfigDialog] = useState<LocationConfigDialogState | null>(null);

  async function loadAorPage() {
    setLoadStatus('loading');
    setLoadError(null);
    try {
      const [aorList, locationConfigsRsp] = await Promise.all([
        listAors({ sortBy: null }),
        listAorLocationConfigs(),
      ]);
      setAvailableLocationConfigs(locationConfigsRsp.availableConfigs);
      setAors(buildAorRows(aorList, buildLocationConfigsByAorId(locationConfigsRsp.items)));
      setLoadStatus('success');
    } catch (error) {
      setLoadStatus('error');
      setLoadError(formatErrorMessage(error));
    }
  }

  useEffect(() => {
    void loadAorPage();
  }, []);

  function openLocationConfigDialog(aor: AorRow) {
    setLocationConfigDialog({
      aorId: aor.id,
      aorName: aor.name,
      selectedConfigs: aor.locationConfigs,
      isSaving: false,
      error: null,
    });
  }

  function closeLocationConfigDialog() {
    setLocationConfigDialog((current) => (current?.isSaving ? current : null));
  }

  function onLocationConfigChange(event: SelectChangeEvent<string[]>) {
    const value = event.target.value;
    const selectedConfigs = typeof value === 'string' ? value.split(',') : value;
    setLocationConfigDialog((current) =>
      current
        ? {
            ...current,
            selectedConfigs,
            error: null,
          }
        : current
    );
  }

  function clearLocationConfigSelection() {
    setLocationConfigDialog((current) =>
      current
        ? {
            ...current,
            selectedConfigs: [],
            error: null,
          }
        : current
    );
  }

  async function saveLocationConfig() {
    if (!locationConfigDialog) return;
    setLocationConfigDialog((current) =>
      current
        ? {
            ...current,
            isSaving: true,
            error: null,
          }
        : current
    );

    try {
      const saved = await saveAorLocationConfig(locationConfigDialog.aorId, locationConfigDialog.selectedConfigs);
      setAors((prev) =>
        prev.map((aor) =>
          aor.id === saved.aorId
            ? {
                ...aor,
                locationConfigs: saved.selectedConfigs,
              }
            : aor
        )
      );
      setLocationConfigDialog(null);
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      setLocationConfigDialog((current) =>
        current
          ? {
              ...current,
              isSaving: false,
              error: errorMessage,
            }
          : current
      );
    }
  }

  const renderTable = () => {
    return (
      <TableContentState
        status={loadStatus}
        errorMessage={loadError || 'Помилка завантаження'}
        loadingContent={
          <div className="flex w-full min-w-0 flex-1 min-h-0">
            <AorTable data={aors} loading onConfigure={openLocationConfigDialog} />
          </div>
        }
      >
        <div className="flex w-full min-w-0 flex-1 min-h-0">
          <AorTable data={aors} loading={false} onConfigure={openLocationConfigDialog} />
        </div>
      </TableContentState>
    );
  };

  return (
    <Box className="w-full" sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: { xs: 'visible', lg: 'hidden' } }}>
      <Stack spacing={3} useFlexGap sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: { xs: 'visible', lg: 'hidden' } }}>
        <TablePageToolbar
          title="Смуги відповідальності"
          withGlobalTextFilter
          hideGlobalTextFilter={loadStatus !== 'success'}
          internalActionsDisabled={loadStatus !== 'success'}
          actions={
            <div className="flex gap-3">
              <Button variant="contained" onClick={() => navigateWithinSpa(buildCreateHref())}>
                Додати смугу
              </Button>
            </div>
          }
        />

        <Box sx={{ flex: 1, minHeight: { xs: 'auto', lg: 0 }, minWidth: 0, display: 'flex' }}>{renderTable()}</Box>

        <Dialog open={Boolean(locationConfigDialog)} onClose={closeLocationConfigDialog} maxWidth="sm" fullWidth>
          <DialogTitle>Конфігурація локацій</DialogTitle>
          <DialogContent>
            {locationConfigDialog ? (
              <Stack spacing={2} sx={{ pt: 1 }}>
                <Typography>Смуга: {formatMrtCellTextValue(locationConfigDialog.aorName)}</Typography>
                {locationConfigDialog.error ? <Alert severity="error">{locationConfigDialog.error}</Alert> : null}
                <FormControl size="small" fullWidth>
                  <Select
                    multiple
                    value={locationConfigDialog.selectedConfigs}
                    onChange={onLocationConfigChange}
                    renderValue={(selected) =>
                      selected.length > 0 ? selected.join(', ') : 'За замовчуванням (config.toml)'
                    }
                    disabled={locationConfigDialog.isSaving}
                    displayEmpty
                    input={
                      <OutlinedInput
                        endAdornment={
                          locationConfigDialog.selectedConfigs.length > 0 ? (
                            <InputAdornment position="end" sx={{ mr: 3 }}>
                              <IconButton
                                edge="end"
                                size="small"
                                aria-label="Очистити конфігурацію локацій"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                }}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  clearLocationConfigSelection();
                                }}
                                disabled={locationConfigDialog.isSaving}
                              >
                                <ClearIcon fontSize="small" />
                              </IconButton>
                            </InputAdornment>
                          ) : undefined
                        }
                      />
                    }
                    sx={{
                      '& .MuiSelect-select': {
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      },
                    }}
                  >
                    {availableLocationConfigs.map((config) => (
                      <MenuItem value={config} key={config}>
                        {config}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>
            ) : null}
          </DialogContent>
          <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
            <Button onClick={closeLocationConfigDialog} disabled={locationConfigDialog?.isSaving}>
              Скасувати
            </Button>
            <Button
              variant="contained"
              onClick={() => void saveLocationConfig()}
              disabled={locationConfigDialog?.isSaving}
              startIcon={locationConfigDialog?.isSaving ? <CircularProgress color="inherit" size={16} /> : null}
            >
              Зберегти
            </Button>
          </DialogActions>
        </Dialog>
      </Stack>
    </Box>
  );
}

export function AdminAorNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-aor-neo"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <AdminAorNeoPageBody />
    </TableStateProvider>
  );
}
