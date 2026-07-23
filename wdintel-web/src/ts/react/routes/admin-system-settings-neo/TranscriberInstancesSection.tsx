import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import {
  Box,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { STANDARD_DIALOG_ACTIONS_SX } from '../../components/dialogStyles';
import { MrtRowActionButton } from '../../components/MrtRowActionButton';
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
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import {
  checkTranscriberInstance,
  createTranscriberInstance,
  deleteTranscriberInstance,
  listTranscriberInstances,
  type TranscriberInstance,
  type TranscriberInstanceHealth,
  type TranscriberInstanceInput,
  type TranscriberMutationResult,
  updateTranscriberInstance,
} from '../../services/api/transcriber';

const GPU_INSTANCE_TEXT_MAX_CHARS = 255;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

const DEFAULT_COLUMNS_VISIBILITY = {
  ordering: true,
  name: true,
  host: true,
  rs_port: true,
  py_port: true,
  is_active: true,
};

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'ordering',
  'name',
  'host',
  'rs_port',
  'py_port',
  'is_active',
];

const defaultMRTOptions = getDefaultMRTOptions<TranscriberInstance>();

type EditorMode = 'create' | 'edit' | null;

type PendingMutation = {
  title: string;
  instanceId?: string;
  closeEditorOnSuccess?: boolean;
  run: () => Promise<TranscriberMutationResult>;
};

function emptyInputForInstances(instances: TranscriberInstance[]): TranscriberInstanceInput {
  return {
    name: '',
    host: '',
    rs_port: 3001,
    py_port: 3000,
    ordering: Math.max(0, ...instances.map((instance) => instance.ordering)) + 1,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validate(input: TranscriberInstanceInput): string | null {
  if (!input.name.trim()) return 'Вкажіть назву інстансу.';
  if (!input.host.trim()) return 'Вкажіть хост інстансу.';
  if (
    [...input.name].length > GPU_INSTANCE_TEXT_MAX_CHARS ||
    [...input.host].length > GPU_INSTANCE_TEXT_MAX_CHARS
  ) {
    return `Назва та хост мають містити не більше ${GPU_INSTANCE_TEXT_MAX_CHARS} символів.`;
  }
  if (
    !Number.isInteger(input.ordering) ||
    input.ordering < 1 ||
    input.ordering > POSTGRES_INTEGER_MAX
  ) {
    return `Порядок має бути цілим числом від 1 до ${POSTGRES_INTEGER_MAX}.`;
  }
  if (
    ![input.rs_port, input.py_port].every(
      (port) => Number.isInteger(port) && port >= 1 && port <= 65535,
    )
  ) {
    return 'Порти мають бути цілими числами від 1 до 65535.';
  }
  return null;
}

function healthText(health: TranscriberInstanceHealth['rust']): string {
  if (health.ok) return 'доступний';
  const details = [health.status, health.error].filter(
    (value): value is number | string => value !== null && value !== '',
  );
  return details.length > 0 ? `недоступний (${details.join(': ')})` : 'недоступний';
}

function sortInstances(instances: TranscriberInstance[]): TranscriberInstance[] {
  return [...instances].sort(
    (left, right) =>
      left.ordering - right.ordering ||
      left.created_at - right.created_at ||
      left.id.localeCompare(right.id),
  );
}

function TranscriberInstancesTable({
  instances,
  loading,
  onEdit,
  onDelete,
}: {
  instances: TranscriberInstance[];
  loading: boolean;
  onEdit: (instance: TranscriberInstance) => void;
  onDelete: (instance: TranscriberInstance) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo<MRT_ColumnDef<TranscriberInstance>[]>(
    () => [
      { header: 'Порядок', accessorKey: 'ordering', size: 90 },
      { header: 'Назва', accessorKey: 'name', size: 180 },
      { header: 'Хост', accessorKey: 'host', size: 220 },
      { header: 'Rust порт', accessorKey: 'rs_port', size: 110 },
      { header: 'Python порт', accessorKey: 'py_port', size: 120 },
      {
        header: 'Активний',
        accessorKey: 'is_active',
        size: 110,
        Cell: ({ cell }) => (cell.getValue<boolean>() ? 'Так' : 'Ні'),
      },
    ],
    [],
  );

  const table = useMaterialReactTable({
    columns,
    data: instances,
    ...defaultMRTOptions,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => (
      <Stack direction="row" spacing={0.5}>
        <MrtRowActionButton
          label="Редагувати"
          onClick={() => onEdit(row.original)}
          icon={<EditIcon fontSize="small" />}
          disabled={loading}
          opensModal
        />
        <MrtRowActionButton
          label="Видалити"
          onClick={() => onDelete(row.original)}
          icon={<DeleteIcon fontSize="small" />}
          disabled={loading}
          tone="danger"
          opensModal
        />
      </Stack>
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
    defaultColumn: {
      size: 180,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: 80,
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
    muiTablePaperProps: ({ table }) => getDefaultMrtPaperProps({ table, loading, layout: 'list' }),
    muiTableContainerProps: ({ table }) =>
      getDefaultMrtContainerProps({
        loading,
        layout: 'list',
        fullScreen: table.getState().isFullScreen,
        hasRows: instances.length > 0,
      }),
    state: {
      showAlertBanner: false,
      isLoading: loading && instances.length === 0,
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

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function InstanceEditorDialog({
  mode,
  input,
  isActive,
  loading,
  error,
  health,
  onInputChange,
  onIsActiveChange,
  onCheck,
  onClose,
  onSave,
}: {
  mode: EditorMode;
  input: TranscriberInstanceInput;
  isActive: boolean;
  loading: boolean;
  error: string | null;
  health?: TranscriberInstanceHealth;
  onInputChange: (patch: Partial<TranscriberInstanceInput>) => void;
  onIsActiveChange: (checked: boolean) => void;
  onCheck: () => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const isCreateMode = mode === 'create';

  return (
    <Dialog open={mode !== null} onClose={onClose} fullWidth maxWidth="sm" disableRestoreFocus>
      <DialogTitle>
        {isCreateMode ? 'Додати Echo GPU інстанс' : 'Редагувати Echo GPU інстанс'}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          <TextField
            autoFocus
            fullWidth
            label="Назва"
            value={input.name}
            disabled={loading}
            onChange={(event) => onInputChange({ name: event.target.value })}
          />
          <TextField
            fullWidth
            label="Хост"
            value={input.host}
            disabled={loading}
            onChange={(event) => onInputChange({ host: event.target.value })}
          />
          <TextField
            fullWidth
            label="Rust порт"
            type="number"
            value={input.rs_port}
            disabled={loading}
            slotProps={{ htmlInput: { min: 1, max: 65535 } }}
            onChange={(event) => onInputChange({ rs_port: Number(event.target.value) })}
          />
          <TextField
            fullWidth
            label="Python порт"
            type="number"
            value={input.py_port}
            disabled={loading}
            slotProps={{ htmlInput: { min: 1, max: 65535 } }}
            onChange={(event) => onInputChange({ py_port: Number(event.target.value) })}
          />
          <TextField
            fullWidth
            label="Порядок"
            type="number"
            value={input.ordering}
            disabled={loading}
            slotProps={{ htmlInput: { min: 1, max: POSTGRES_INTEGER_MAX } }}
            onChange={(event) => onInputChange({ ordering: Number(event.target.value) })}
          />
          {!isCreateMode ? (
            <FormControlLabel
              control={
                <Switch
                  checked={isActive}
                  disabled={loading}
                  onChange={(_, checked) => onIsActiveChange(checked)}
                />
              }
              label="Активний"
            />
          ) : null}
          {health ? (
            <Typography variant="body2">
              Rust: {healthText(health.rust)}; Python: {healthText(health.python)}
            </Typography>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        {!isCreateMode ? (
          <PowerButton type="button" variant="outlined" disabled={loading} onClick={onCheck}>
            Перевірити
          </PowerButton>
        ) : null}
        <PowerButton type="button" disabled={loading} onClick={onClose}>
          Скасувати
        </PowerButton>
        <PowerButton type="button" variant="contained" disabled={loading} onClick={onSave}>
          {isCreateMode ? 'Додати' : 'Зберегти'}
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

function MutationConfirmDialog({
  mutation,
  onCancel,
  onConfirm,
}: {
  mutation: PendingMutation | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={mutation !== null} onClose={onCancel}>
      <DialogTitle>{mutation?.title}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Після підтвердження wdintel-rs-bgworker буде коректно перезапущено. Поточне
          транскрибування матиме час завершитися.
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        <PowerButton type="button" onClick={onCancel}>
          Скасувати
        </PowerButton>
        <PowerButton type="button" variant="contained" onClick={onConfirm}>
          Підтвердити
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

function TranscriberInstancesSectionBody() {
  const [instances, setInstances] = useState<TranscriberInstance[]>([]);
  const [input, setInput] = useState(() => emptyInputForInstances([]));
  const [formIsActive, setFormIsActive] = useState(true);
  const [editorMode, setEditorMode] = useState<EditorMode>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [restartWarning, setRestartWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingMutation, setPendingMutation] = useState<PendingMutation | null>(null);
  const [health, setHealth] = useState<Record<string, TranscriberInstanceHealth>>({});
  const { notify } = usePowerSnackbar();

  const refresh = useCallback(async (): Promise<TranscriberInstance[] | null> => {
    setLoading(true);
    setError(null);
    try {
      const nextInstances = sortInstances(await listTranscriberInstances());
      setInstances(nextInstances);
      setHealth({});
      return nextInstances;
    } catch (nextError) {
      setError(`Помилка завантаження GPU інстансів: ${errorMessage(nextError)}`);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function openCreate() {
    setInput(emptyInputForInstances(instances));
    setFormIsActive(true);
    setEditingId(null);
    setFormError(null);
    setEditorMode('create');
  }

  function openEdit(instance: TranscriberInstance) {
    setInput({
      name: instance.name,
      host: instance.host,
      rs_port: instance.rs_port,
      py_port: instance.py_port,
      ordering: instance.ordering,
    });
    setFormIsActive(instance.is_active);
    setEditingId(instance.id);
    setFormError(null);
    setEditorMode('edit');
  }

  function closeEditor() {
    if (loading) return;
    setEditorMode(null);
    setEditingId(null);
    setFormError(null);
  }

  function requestSave() {
    const normalized = { ...input, name: input.name.trim(), host: input.host.trim() };
    const validationError = validate(normalized);
    if (validationError) {
      setFormError(validationError);
      return;
    }

    const instanceId = editingId ?? undefined;
    setPendingMutation({
      title: instanceId ? 'Зберегти зміни GPU інстансу?' : 'Створити GPU інстанс?',
      instanceId,
      closeEditorOnSuccess: true,
      run: () =>
        instanceId
          ? updateTranscriberInstance(instanceId, {
              ...normalized,
              is_active: formIsActive,
            })
          : createTranscriberInstance(normalized),
    });
  }

  async function runConfirmedMutation() {
    const mutation = pendingMutation;
    if (!mutation) return;
    setPendingMutation(null);
    setLoading(true);
    setError(null);
    setFormError(null);
    setRestartWarning(null);
    try {
      const result = await mutation.run();
      if (result.restart_status === 'failed') {
        setRestartWarning(
          `Конфігурацію збережено, але її не вдалося повністю застосувати: ${result.restart_error ?? 'невідома помилка'}`,
        );
      } else {
        notify({
          severity: 'success',
          message: 'Конфігурацію GPU збережено; воркер перезапускається.',
        });
      }

      const affectedInstanceId = result.instance?.id ?? mutation.instanceId;
      const knownInstances = sortInstances(
        result.instance
          ? [
              ...instances.filter((instance) => instance.id !== result.instance?.id),
              result.instance,
            ]
          : result.deleted && mutation.instanceId
            ? instances.filter((instance) => instance.id !== mutation.instanceId)
            : instances,
      );
      setInstances(knownInstances);
      if (affectedInstanceId) {
        setHealth((current) => {
          const next = { ...current };
          delete next[affectedInstanceId];
          return next;
        });
      }

      const nextInstances = await refresh();
      setInput(emptyInputForInstances(nextInstances ?? knownInstances));
      if (mutation.closeEditorOnSuccess) {
        setEditorMode(null);
        setEditingId(null);
      }
    } catch (nextError) {
      const message = `Помилка зміни GPU інстансу: ${errorMessage(nextError)}`;
      if (editorMode) {
        setFormError(message);
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function checkEditingInstance() {
    if (!editingId) return;
    setLoading(true);
    setFormError(null);
    setHealth((current) => {
      const next = { ...current };
      delete next[editingId];
      return next;
    });
    try {
      const result = await checkTranscriberInstance(editingId);
      setHealth((current) => ({ ...current, [editingId]: result }));
    } catch (nextError) {
      setFormError(`Помилка перевірки інстансу: ${errorMessage(nextError)}`);
    } finally {
      setLoading(false);
    }
  }

  const editingHealth = editingId ? health[editingId] : undefined;
  return (
    <Stack spacing={2}>
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      {restartWarning ? <PowerAlert severity="warning">{restartWarning}</PowerAlert> : null}

      <TablePageToolbar
        title="Echo GPU інстанси"
        withGlobalTextFilter
        hideGlobalTextFilter={loading && instances.length === 0}
        internalActionsDisabled={loading && instances.length === 0}
        actions={
          <>
            <PowerButton type="button" variant="outlined" disabled={loading} onClick={refresh}>
              Оновити
            </PowerButton>
            <PowerButton type="button" variant="contained" disabled={loading} onClick={openCreate}>
              Додати інстанс
            </PowerButton>
          </>
        }
      />

      <Box sx={{ width: '100%', minWidth: 0 }}>
        <TranscriberInstancesTable
          instances={instances}
          loading={loading}
          onEdit={openEdit}
          onDelete={(instance) =>
            setPendingMutation({
              title: 'Видалити GPU інстанс?',
              instanceId: instance.id,
              run: () => deleteTranscriberInstance(instance.id),
            })
          }
        />
      </Box>

      <InstanceEditorDialog
        mode={editorMode}
        input={input}
        isActive={formIsActive}
        loading={loading}
        error={formError}
        health={editingHealth}
        onInputChange={(patch) => setInput((current) => ({ ...current, ...patch }))}
        onIsActiveChange={setFormIsActive}
        onCheck={checkEditingInstance}
        onClose={closeEditor}
        onSave={requestSave}
      />

      <MutationConfirmDialog
        mutation={pendingMutation}
        onCancel={() => setPendingMutation(null)}
        onConfirm={runConfirmedMutation}
      />
    </Stack>
  );
}

export function TranscriberInstancesSection() {
  return (
    <TableStateProvider
      tableId="admin-transcriber-instances"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <TranscriberInstancesSectionBody />
    </TableStateProvider>
  );
}
