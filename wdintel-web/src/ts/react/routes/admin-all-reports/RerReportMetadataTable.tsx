import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Autocomplete,
  Box,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';

import type { RerReportMetadataItem } from '../../../../Bindings';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import { EchoChip } from '../../components/EchoChip';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  mrtItemsCell,
  renderColumnActionsMenuItems,
  useAppMaterialReactTable,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import {
  createRerReportMetadata,
  deleteRerReportMetadata,
  updateRerReportMetadata,
} from '../../services/api/rer-report-admin';
import { isAbortError } from '../../services/api/client';
import { DEFAULT_LIST_UNITS_REQ, searchUnitsStrictThenRelaxed } from '../../services/api/units';

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'sigintUnitName',
  'locations',
  'labels',
];
const DEFAULT_COLUMN_VISIBILITY = {
  sigintUnitName: true,
  locations: true,
  labels: true,
};
const ROW_ACTIONS_COLUMN_SIZE = 56;

type UnitOption = { id: number; name: string };
type EditorState = {
  id: number | null;
  unit: UnitOption | null;
  locations: string[];
  labels: string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function normalizeValues(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function sortRows(rows: RerReportMetadataItem[]): RerReportMetadataItem[] {
  return [...rows].sort(
    (left, right) =>
      left.sigintUnitName.localeCompare(right.sigintUnitName, 'uk') || left.id - right.id,
  );
}

function MetadataTable({
  rows,
  loading,
  onEdit,
  onDelete,
}: {
  rows: RerReportMetadataItem[];
  loading: boolean;
  onEdit: (row: RerReportMetadataItem) => void;
  onDelete: (row: RerReportMetadataItem) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo<AppMrtColumnDef<RerReportMetadataItem>[]>(
    () => [
      {
        accessorKey: 'sigintUnitName',
        header: 'sigint_unit_name',
        size: 280,
      },
      {
        id: 'locations',
        accessorFn: (row) => row.locations.join(', '),
        header: 'locations',
        size: 320,
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<RerReportMetadataItem, string>({
          items: ({ row }) => row.original.locations,
          renderItem: (location) => <EchoChip label={location} tone="neutral" />,
          measurementScope: 'admin-rer-report:locations',
          getItemKey: (location) => location,
          getItemText: (location) => location,
        }),
      },
      {
        id: 'labels',
        accessorFn: (row) => row.labels.join(', '),
        header: 'labels',
        size: 320,
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<RerReportMetadataItem, string>({
          items: ({ row }) => row.original.labels,
          renderItem: (label) => <EchoChip label={label} tone="neutral" />,
          measurementScope: 'admin-rer-report:labels',
          getItemKey: (label) => label,
          getItemText: (label) => label,
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
        <MrtRowActionButton
          label="Видалити"
          icon={<DeleteIcon fontSize="small" />}
          onClick={() => onDelete(row.original)}
          disabled={loading}
          tone="danger"
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

function MetadataEditor({
  state,
  rows,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  state: EditorState | null;
  rows: RerReportMetadataItem[];
  saving: boolean;
  error: string | null;
  onChange: (state: EditorState) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { notify } = usePowerSnackbar();
  const [unitInput, setUnitInput] = useState('');
  const [unitOptions, setUnitOptions] = useState<UnitOption[]>([]);
  const [unitLoading, setUnitLoading] = useState(false);

  useEffect(() => {
    if (!state) return;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setUnitLoading(true);
      try {
        const units = await searchUnitsStrictThenRelaxed(
          {
            ...DEFAULT_LIST_UNITS_REQ,
            filterText: unitInput.trim() || null,
            limit: 50,
          },
          { signal: controller.signal },
        );
        const usedUnitIds = new Set(
          rows.filter((row) => row.id !== state.id).map((row) => row.sigintUnitId),
        );
        const options = units
          .filter((unit) => !usedUnitIds.has(unit.id))
          .map((unit) => ({ id: unit.id, name: unit.name }));
        if (state.unit && !options.some((option) => option.id === state.unit?.id)) {
          options.unshift(state.unit);
        }
        setUnitOptions(options);
      } catch (nextError) {
        if (!isAbortError(nextError)) {
          setUnitOptions(state.unit ? [state.unit] : []);
          notify({
            severity: 'error',
            message: `Не вдалося знайти підрозділи: ${errorMessage(nextError)}`,
          });
        }
      } finally {
        if (!controller.signal.aborted) setUnitLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [state?.id, state?.unit?.id, unitInput, rows, notify]);

  useEffect(() => {
    if (state) setUnitInput(state.unit?.name ?? '');
  }, [state?.id]);

  return (
    <Dialog open={state !== null} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {state?.id === null ? 'Додати метадані РЕР' : 'Редагувати метадані РЕР'}
      </DialogTitle>
      <DialogContent>
        {state ? (
          <Stack spacing={2} sx={{ pt: 1 }}>
            {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
            <Autocomplete<UnitOption>
              options={unitOptions}
              value={state.unit}
              inputValue={unitInput}
              loading={unitLoading}
              filterOptions={(options) => options}
              getOptionLabel={(option) => option.name}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              onInputChange={(_, value, reason) => {
                if (reason === 'input' || reason === 'clear') setUnitInput(value);
              }}
              onChange={(_, unit) =>
                onChange({
                  ...state,
                  unit,
                  labels:
                    state.id === null && state.labels.length === 0 && unit
                      ? [unit.name]
                      : state.labels,
                })
              }
              noOptionsText="Підрозділів не знайдено"
              loadingText="Пошук…"
              renderInput={(params) => <TextField {...params} label="Підрозділ" required />}
            />
            <Autocomplete<string, true, false, true>
              multiple
              freeSolo
              autoSelect
              options={[]}
              value={state.locations}
              onChange={(_, values) =>
                onChange({ ...state, locations: normalizeValues(values.map(String)) })
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="locations"
                  helperText="Введіть значення та натисніть Enter"
                />
              )}
            />
            <Autocomplete<string, true, false, true>
              multiple
              freeSolo
              autoSelect
              options={[]}
              value={state.labels}
              onChange={(_, values) =>
                onChange({ ...state, labels: normalizeValues(values.map(String)) })
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="labels"
                  helperText="Введіть значення та натисніть Enter"
                />
              )}
            />
          </Stack>
        ) : null}
      </DialogContent>
      <DialogActions>
        <PowerButton variant="outlined" onClick={onClose} disabled={saving}>
          Скасувати
        </PowerButton>
        <PowerButton variant="contained" onClick={onSave} disabled={saving || !state?.unit}>
          {saving ? 'Збереження…' : 'Зберегти'}
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

function RerReportMetadataTableBody({
  rows,
  setRows,
  loading,
  onReload,
}: {
  rows: RerReportMetadataItem[];
  setRows: (rows: RerReportMetadataItem[]) => void;
  loading: boolean;
  onReload: () => void;
}) {
  const { notify } = usePowerSnackbar();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleting, setDeleting] = useState<RerReportMetadataItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openCreate() {
    setError(null);
    setEditor({ id: null, unit: null, locations: [], labels: [] });
  }

  function openEdit(row: RerReportMetadataItem) {
    setError(null);
    setEditor({
      id: row.id,
      unit: { id: row.sigintUnitId, name: row.sigintUnitName },
      locations: row.locations,
      labels: row.labels,
    });
  }

  async function save() {
    if (!editor?.unit) return;
    const locations = normalizeValues(editor.locations);
    const labels = normalizeValues(editor.labels);
    if (locations.length === 0 && labels.length === 0) {
      setError('Додайте принаймні одну локацію або мітку.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved =
        editor.id === null
          ? await createRerReportMetadata({
              sigintUnitId: editor.unit.id,
              locations,
              labels,
            })
          : await updateRerReportMetadata({
              id: editor.id,
              sigintUnitId: editor.unit.id,
              locations,
              labels,
            });
      setRows(sortRows([...rows.filter((row) => row.id !== saved.id), saved]));
      setEditor(null);
      notify({ severity: 'success', message: 'Метадані РЕР збережено.' });
    } catch (nextError) {
      const message = errorMessage(nextError);
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    setSaving(true);
    try {
      await deleteRerReportMetadata({ id: deleting.id });
      setRows(rows.filter((row) => row.id !== deleting.id));
      setDeleting(null);
      notify({ severity: 'success', message: 'Метадані РЕР видалено.' });
    } catch (nextError) {
      notify({ severity: 'error', message: errorMessage(nextError) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Stack spacing={2} sx={{ height: '100%', minHeight: 0 }}>
      <TablePageToolbar
        title="Метадані підрозділів для звіту РЕР"
        withGlobalTextFilter
        internalActionsDisabled={loading}
        actions={
          <>
            <PowerButton
              variant="contained"
              startIcon={<AddIcon />}
              onClick={openCreate}
              disabled={loading || saving}
            >
              Додати новий
            </PowerButton>
            <PowerButton
              variant="outlined"
              startIcon={<RefreshIcon />}
              onClick={onReload}
              disabled={loading || saving}
            >
              Оновити
            </PowerButton>
          </>
        }
      />
      <Box sx={{ flex: 1, minHeight: 320, minWidth: 0, display: 'flex' }}>
        <MetadataTable
          rows={rows}
          loading={loading || saving}
          onEdit={openEdit}
          onDelete={setDeleting}
        />
      </Box>
      <MetadataEditor
        state={editor}
        rows={rows}
        saving={saving}
        error={error}
        onChange={setEditor}
        onClose={() => !saving && setEditor(null)}
        onSave={() => void save()}
      />
      <ConfirmDangerDialog
        open={deleting !== null}
        onClose={() => !saving && setDeleting(null)}
        onConfirm={() => void remove()}
        submitting={saving}
        title="Видалити метадані РЕР?"
        description={
          deleting ? `Метадані підрозділу «${deleting.sigintUnitName}» буде видалено.` : undefined
        }
      />
    </Stack>
  );
}

export function RerReportMetadataTable(props: {
  rows: RerReportMetadataItem[];
  setRows: (rows: RerReportMetadataItem[]) => void;
  loading: boolean;
  onReload: () => void;
}) {
  return (
    <TableStateProvider
      tableId="admin-rer-report-metadata"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <RerReportMetadataTableBody {...props} />
    </TableStateProvider>
  );
}
