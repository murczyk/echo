import EditIcon from '@mui/icons-material/Edit';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Box,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  ListItemText,
  MenuItem,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';

import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PageErrorState } from '../../components/PageErrorState';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  getDefaultMRTOptions,
  mrtItemsCell,
  useAppMaterialReactTable,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import {
  type AorLocationConfigItem,
  listAorLocationConfigs,
  saveAorLocationConfig,
} from '../../services/api/location-config';
import { ELLIPSIS } from '../../utils/misc';

const ROW_ACTIONS_COLUMN_SIZE = 56;
const DEFAULT_COLUMN_ORDER = ['mrt-row-numbers', 'mrt-row-actions', 'aorName', 'selectedConfigs'];
const DEFAULT_COLUMN_VISIBILITY = { aorName: true, selectedConfigs: true };
const defaultMRTOptions = getDefaultMRTOptions<AorLocationConfigItem>();

function formatConfigName(config: string): string {
  return config.split('/').pop() || config;
}

function formatSelectedConfigs(configs: string[]): string {
  return configs.length > 0
    ? configs.map(formatConfigName).join(', ')
    : 'Набір сервера за замовчуванням';
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Невідома помилка';
}

function LocationConfigsTable({
  rows,
  loading,
  onEdit,
}: {
  rows: AorLocationConfigItem[];
  loading: boolean;
  onEdit: (row: AorLocationConfigItem) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo<AppMrtColumnDef<AorLocationConfigItem>[]>(
    () => [
      { accessorKey: 'aorName', header: 'AOR (смуга відповідальності)', size: 260 },
      {
        id: 'selectedConfigs',
        accessorFn: (row) => formatSelectedConfigs(row.selectedConfigs),
        header: 'Файли settlements.json',
        size: 600,
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<AorLocationConfigItem, string>({
          items: ({ row }) => row.original.selectedConfigs,
          renderItem: (config) => <Typography variant="body2">{config}</Typography>,
          getItemKey: (config) => config,
          getItemText: (config) => config,
        }),
      },
    ],
    [],
  );
  const table = useAppMaterialReactTable({
    columns,
    data: rows,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => (
      <MrtRowActions>
        <MrtRowActionButton
          label="Редагувати"
          icon={<EditIcon fontSize="small" />}
          onClick={() => onEdit(row.original)}
          disabled={loading}
          opensModal
        />
      </MrtRowActions>
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
    defaultColumn: { size: 200, renderColumnActionsMenuItems },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: ROW_ACTIONS_COLUMN_SIZE,
        minSize: ROW_ACTIONS_COLUMN_SIZE,
        maxSize: ROW_ACTIONS_COLUMN_SIZE,
      },
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        muiTableBodyCellProps: () => ({
          sx: { justifyContent: 'center', ...CUSTOM_CELL_STYLES },
        }),
      },
    },
    muiTablePaperProps: ({ table }) =>
      getDefaultMrtPaperProps({ table, loading, layout: 'workspace' }),
    muiTableContainerProps: ({ table }) =>
      getDefaultMrtContainerProps({
        loading,
        layout: 'workspace',
        fullScreen: table.getState().isFullScreen,
        hasRows: rows.length > 0,
      }),
    state: {
      showAlertBanner: false,
      showProgressBars: loading,
      globalFilter: tableStateContext.globalFilter,
      columnVisibility: tableStateContext.columnVisibility,
      columnFilters: tableStateContext.columnFilters,
      density: tableStateContext.density,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
    },
  });

  useEffect(() => tableStateContext.onTableInitialized(table), [table]);

  return <MaterialReactTable table={table} />;
}

function AdminLocationConfigsNeoPageBody() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [availableConfigs, setAvailableConfigs] = useState<string[]>([]);
  const [rows, setRows] = useState<AorLocationConfigItem[]>([]);
  const [editingRow, setEditingRow] = useState<AorLocationConfigItem | null>(null);
  const [editedConfigs, setEditedConfigs] = useState<string[]>([]);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await listAorLocationConfigs();
      setAvailableConfigs(data.availableConfigs);
      setRows(data.items);
    } catch (error) {
      setLoadError(formatErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function openEditor(row: AorLocationConfigItem) {
    setEditingRow(row);
    setEditedConfigs(row.selectedConfigs);
    setSaveError(null);
  }

  async function save() {
    if (!editingRow) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveAorLocationConfig(editingRow.aorId, editedConfigs);
      setRows((current) => current.map((row) => (row.aorId === saved.aorId ? saved : row)));
      setEditingRow(null);
    } catch (error) {
      setSaveError(formatErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  if (loading && rows.length === 0 && !loadError) return <PageLoadingState minHeight="100%" />;
  if (loadError && rows.length === 0) {
    return (
      <PageErrorState
        message={loadError}
        actionLabel="Спробувати ще раз"
        onAction={() => void load()}
        minHeight="100%"
      />
    );
  }

  return (
    <Box sx={{ height: { xs: 'auto', lg: '100%' }, minHeight: 0, overflow: 'hidden' }}>
      <Stack spacing={3} useFlexGap sx={{ height: '100%', minHeight: 0 }}>
        {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
        {availableConfigs.length === 0 ? (
          <PowerAlert severity="warning">
            У каталозі settlements_json немає доступних регіональних файлів.
          </PowerAlert>
        ) : null}
        <TablePageToolbar
          title="Файли населених пунктів для AOR"
          titleInfo="Регіональні JSON-файли, у яких ECHO шукає населені пункти для кожної смуги відповідальності. Порожній вибір використовує набір сервера за замовчуванням."
          withGlobalTextFilter
          internalActionsDisabled={loading && rows.length === 0}
          actions={
            <PowerButton
              variant="outlined"
              startIcon={<RefreshIcon />}
              onClick={() => void load()}
              disabled={loading}
            >
              Оновити
            </PowerButton>
          }
        />
        <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
          <LocationConfigsTable rows={rows} loading={loading || saving} onEdit={openEditor} />
        </Box>
      </Stack>

      <Dialog open={editingRow !== null} onClose={() => !saving && setEditingRow(null)} fullWidth>
        <DialogTitle>Редагувати файли для {editingRow?.aorName}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}
            <FormControl size="small" fullWidth>
              <Select
                multiple
                displayEmpty
                value={editedConfigs}
                onChange={(event) => {
                  const value = event.target.value;
                  setEditedConfigs(typeof value === 'string' ? value.split(',') : value);
                  setSaveError(null);
                }}
                renderValue={(selected) => formatSelectedConfigs(selected)}
              >
                {availableConfigs.map((config) => (
                  <MenuItem value={config} key={config}>
                    <Checkbox checked={editedConfigs.includes(config)} />
                    <ListItemText primary={formatConfigName(config)} />
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <PowerButton variant="outlined" onClick={() => setEditingRow(null)} disabled={saving}>
            Скасувати
          </PowerButton>
          <PowerButton variant="contained" onClick={() => void save()} disabled={saving}>
            {saving ? `Збереження${ELLIPSIS}` : 'Зберегти'}
          </PowerButton>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export function AdminLocationConfigsNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-location-configs"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <AdminLocationConfigsNeoPageBody />
    </TableStateProvider>
  );
}
