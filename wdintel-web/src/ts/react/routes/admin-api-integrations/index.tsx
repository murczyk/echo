import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import {
  Autocomplete,
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
} from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useState } from 'react';

import type { ApiIntegration, Login, UpsertApiIntegrationReq } from '../../../../Bindings';
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
  useAppMaterialReactTable,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import {
  deleteApiIntegration,
  listApiIntegrations,
  testConnection,
  upsertApiIntegration,
} from '../../services/api/api-integrations';
import { listLogins } from '../../services/api/logins';

type ApiIntegrationForm = {
  id: number | null;
  description: string;
  apiUser: string;
  hasIggyConnection: boolean;
  iggyUrl: string;
  iggyLogin: string;
  iggyPassword: string;
  iggyInboxTopic: string;
  iggyAnalyticsTopic: string;
  syncEnabled: boolean;
};

type FormStatus = {
  kind: 'success' | 'error';
  message: string;
} | null;

const ROW_ACTIONS_COLUMN_SIZE = 96;
const DEFAULT_COLUMNS_VISIBILITY = {
  description: true,
  api_user: true,
  has_iggy_connection: true,
  sync_enabled: true,
  is_working: true,
  last_sync_at: true,
};
const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'description',
  'api_user',
  'has_iggy_connection',
  'sync_enabled',
  'is_working',
  'last_sync_at',
];
const defaultMRTOptions = getDefaultMRTOptions<ApiIntegration>();

function emptyForm(): ApiIntegrationForm {
  return {
    id: null,
    description: '',
    apiUser: '',
    hasIggyConnection: false,
    iggyUrl: '',
    iggyLogin: '',
    iggyPassword: '',
    iggyInboxTopic: '',
    iggyAnalyticsTopic: '',
    syncEnabled: false,
  };
}

function toForm(integration: ApiIntegration): ApiIntegrationForm {
  return {
    id: integration.id,
    description: integration.description ?? '',
    apiUser: integration.apiUserLoginId,
    hasIggyConnection: integration.hasIggyConnection,
    iggyUrl: integration.iggyUrl ?? '',
    iggyLogin: integration.iggyLogin ?? '',
    iggyPassword: integration.iggyPassword ?? '',
    iggyInboxTopic: integration.iggyInboxTopic ?? '',
    iggyAnalyticsTopic: integration.iggyAnalyticsTopic ?? '',
    syncEnabled: integration.syncEnabled,
  };
}

function toSaveReq(form: ApiIntegrationForm): UpsertApiIntegrationReq {
  const iggyValue = (value: string) => (form.hasIggyConnection ? value.trim() : null);
  return {
    id: form.id,
    description: form.description.trim() || null,
    apiUserLoginId: form.apiUser,
    hasIggyConnection: form.hasIggyConnection,
    iggyUrl: iggyValue(form.iggyUrl),
    iggyLogin: iggyValue(form.iggyLogin),
    iggyPassword: iggyValue(form.iggyPassword),
    iggyInboxTopic: iggyValue(form.iggyInboxTopic),
    iggyAnalyticsTopic: iggyValue(form.iggyAnalyticsTopic),
    syncEnabled: form.id !== null && form.syncEnabled,
  };
}

function validateIggyConnection(form: ApiIntegrationForm): string | null {
  if (!form.iggyUrl.trim()) return 'Вкажіть Iggy URL';
  if (!form.iggyLogin.trim()) return 'Вкажіть Iggy логін';
  if (!form.iggyPassword.trim()) return 'Вкажіть Iggy пароль';
  return null;
}

function validateForm(form: ApiIntegrationForm): string | null {
  if (!form.apiUser.trim()) return 'Вкажіть API користувача';
  if (!form.hasIggyConnection) return null;
  return (
    validateIggyConnection(form) ||
    (!form.iggyInboxTopic.trim() ? 'Вкажіть тему для вхідних повідомлень' : null) ||
    (!form.iggyAnalyticsTopic.trim() ? 'Вкажіть тему для аналітичної інформації' : null)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'Невідома помилка';
}

function formatLastSync(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleString('uk-UA');
}

function ApiIntegrationsTable({
  integrations,
  apiUsers,
  loading,
  onEdit,
  onDelete,
}: {
  integrations: ApiIntegration[];
  apiUsers: Login[];
  loading: boolean;
  onEdit: (integration: ApiIntegration) => void;
  onDelete: (integration: ApiIntegration) => void;
}) {
  const tableStateContext = useTableStateContext();
  const userNames = useMemo(
    () => new Map(apiUsers.map((user) => [user.id, user.login])),
    [apiUsers],
  );
  const columnSizing = useMemo(
    () => ({
      ...tableStateContext.columnSizing,
      'mrt-row-actions': ROW_ACTIONS_COLUMN_SIZE,
    }),
    [tableStateContext.columnSizing],
  );
  const columns = useMemo<AppMrtColumnDef<ApiIntegration>[]>(
    () => [
      {
        id: 'description',
        header: 'Опис',
        accessorFn: (integration) => integration.description ?? '—',
        size: 220,
      },
      {
        id: 'api_user',
        header: 'API користувач',
        accessorFn: (integration) =>
          userNames.get(integration.apiUserLoginId) ?? integration.apiUserLoginId,
        size: 180,
      },
      {
        id: 'has_iggy_connection',
        header: 'Iggy',
        accessorFn: (integration) => (integration.hasIggyConnection ? 'Так' : 'Ні'),
        size: 90,
      },
      {
        id: 'sync_enabled',
        header: 'Синхронізація',
        accessorFn: (integration) => (integration.syncEnabled ? 'Увімкнена' : 'Вимкнена'),
        size: 140,
      },
      {
        id: 'is_working',
        header: 'Стан',
        accessorFn: (integration) => (integration.isWorking ? 'Працює' : 'Не працює'),
        size: 130,
      },
      {
        id: 'last_sync_at',
        header: 'Остання синхронізація',
        accessorFn: (integration) => formatLastSync(integration.lastSyncAtMs),
        size: 190,
      },
    ],
    [userNames],
  );

  const table = useAppMaterialReactTable({
    columns,
    data: integrations,
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
        <MrtRowActions forceMenu>
          <MrtRowActionButton
            label="Видалити"
            onClick={() => onDelete(row.original)}
            icon={<DeleteIcon fontSize="small" />}
            disabled={loading}
            tone="danger"
            opensModal
          />
        </MrtRowActions>
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
    defaultColumn: { size: 180, renderColumnActionsMenuItems },
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
        hasRows: integrations.length > 0,
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
      columnSizing,
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function IntegrationEditorDialog({
  open,
  form,
  apiUsers,
  busy,
  checking,
  status,
  onFormChange,
  onClose,
  onSave,
  onTest,
}: {
  open: boolean;
  form: ApiIntegrationForm;
  apiUsers: Login[];
  busy: boolean;
  checking: boolean;
  status: FormStatus;
  onFormChange: (form: ApiIntegrationForm) => void;
  onClose: () => void;
  onSave: () => void;
  onTest: () => void;
}) {
  const selectedApiUser = apiUsers.find((user) => user.id === form.apiUser) ?? null;
  const disabled = busy || checking;
  const setHasIggyConnection = (hasIggyConnection: boolean) =>
    onFormChange({
      ...form,
      hasIggyConnection,
      iggyUrl: hasIggyConnection ? form.iggyUrl : '',
      iggyLogin: hasIggyConnection ? form.iggyLogin : '',
      iggyPassword: hasIggyConnection ? form.iggyPassword : '',
      iggyInboxTopic: hasIggyConnection ? form.iggyInboxTopic : '',
      iggyAnalyticsTopic: hasIggyConnection ? form.iggyAnalyticsTopic : '',
      syncEnabled: hasIggyConnection ? form.syncEnabled : false,
    });

  return (
    <Dialog open={open} onClose={() => !disabled && onClose()} fullWidth maxWidth="md">
      <DialogTitle>
        {form.id === null ? 'Створити інтеграцію API' : 'Редагувати інтеграцію API'}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {status ? <PowerAlert severity={status.kind}>{status.message}</PowerAlert> : null}
          <TextField
            label="Опис"
            value={form.description}
            onChange={(event) => onFormChange({ ...form, description: event.target.value })}
            multiline
            minRows={2}
            fullWidth
          />
          <Autocomplete
            options={apiUsers}
            value={selectedApiUser}
            onChange={(_, option) => onFormChange({ ...form, apiUser: option?.id ?? '' })}
            getOptionLabel={(option) => option.login}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            disabled={disabled}
            renderInput={(params) => (
              <TextField {...params} label="API користувач" required fullWidth />
            )}
          />
          <FormControlLabel
            control={
              <Switch
                checked={form.hasIggyConnection}
                onChange={(event) => setHasIggyConnection(event.target.checked)}
                disabled={disabled}
              />
            }
            label="Є підключення до Iggy"
          />
          {form.id !== null ? (
            <FormControlLabel
              control={
                <Switch
                  checked={form.syncEnabled}
                  onChange={(event) => onFormChange({ ...form, syncEnabled: event.target.checked })}
                  disabled={disabled || !form.hasIggyConnection}
                />
              }
              label="Увімкнути синхронізацію"
            />
          ) : null}
          <TextField
            label="Iggy URL"
            value={form.iggyUrl}
            onChange={(event) => onFormChange({ ...form, iggyUrl: event.target.value })}
            placeholder="iggy://localhost:8090"
            disabled={disabled || !form.hasIggyConnection}
            required={form.hasIggyConnection}
            fullWidth
          />
          <TextField
            label="Iggy логін"
            value={form.iggyLogin}
            onChange={(event) => onFormChange({ ...form, iggyLogin: event.target.value })}
            disabled={disabled || !form.hasIggyConnection}
            required={form.hasIggyConnection}
            fullWidth
          />
          <TextField
            label="Iggy пароль"
            type="password"
            value={form.iggyPassword}
            onChange={(event) => onFormChange({ ...form, iggyPassword: event.target.value })}
            disabled={disabled || !form.hasIggyConnection}
            required={form.hasIggyConnection}
            fullWidth
          />
          <TextField
            label="Назва топіку для надсилання вхідних повідомлень"
            value={form.iggyInboxTopic}
            onChange={(event) => onFormChange({ ...form, iggyInboxTopic: event.target.value })}
            disabled={disabled || !form.hasIggyConnection}
            required={form.hasIggyConnection}
            fullWidth
          />
          <TextField
            label="Назва топіку для отримання аналітичної інформації"
            value={form.iggyAnalyticsTopic}
            onChange={(event) => onFormChange({ ...form, iggyAnalyticsTopic: event.target.value })}
            disabled={disabled || !form.hasIggyConnection}
            required={form.hasIggyConnection}
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <PowerButton variant="outlined" onClick={onClose} disabled={disabled}>
          Скасувати
        </PowerButton>
        {form.hasIggyConnection ? (
          <PowerButton variant="outlined" onClick={onTest} disabled={disabled}>
            Перевірити з'єднання
          </PowerButton>
        ) : null}
        <PowerButton variant="contained" onClick={onSave} disabled={disabled}>
          {form.id === null ? 'Створити' : 'Зберегти'}
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}

function AdminApiIntegrationsPageBody() {
  const [integrations, setIntegrations] = useState<ApiIntegration[]>([]);
  const [apiUsers, setApiUsers] = useState<Login[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageStatus, setPageStatus] = useState<FormStatus>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<ApiIntegrationForm>(emptyForm);
  const [formStatus, setFormStatus] = useState<FormStatus>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApiIntegration | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextIntegrations, logins] = await Promise.all([
        listApiIntegrations(),
        listLogins({ sortBy: null, filterByRoles: ['Api'] }),
      ]);
      setIntegrations(nextIntegrations);
      setApiUsers(logins.users.sort((a, b) => a.login.localeCompare(b.login, 'uk')));
    } catch (error) {
      setLoadError(`Не вдалося завантажити інтеграції API: ${errorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function openCreate() {
    setForm(emptyForm());
    setFormStatus(null);
    setEditorOpen(true);
  }

  function openEdit(integration: ApiIntegration) {
    setForm(toForm(integration));
    setFormStatus(null);
    setEditorOpen(true);
  }

  async function save() {
    const validationError = validateForm(form);
    if (validationError) {
      setFormStatus({ kind: 'error', message: validationError });
      return;
    }
    setSaving(true);
    setFormStatus(null);
    try {
      const saved = await upsertApiIntegration(toSaveReq(form));
      setIntegrations((current) => {
        const exists = current.some((integration) => integration.id === saved.id);
        return exists
          ? current.map((integration) => (integration.id === saved.id ? saved : integration))
          : [saved, ...current];
      });
      setEditorOpen(false);
      setPageStatus({ kind: 'success', message: 'Інтеграцію API збережено' });
    } catch (error) {
      setFormStatus({ kind: 'error', message: `Помилка збереження: ${errorMessage(error)}` });
    } finally {
      setSaving(false);
    }
  }

  async function checkConnection() {
    const validationError = validateIggyConnection(form);
    if (validationError) {
      setFormStatus({ kind: 'error', message: validationError });
      return;
    }
    setChecking(true);
    setFormStatus(null);
    try {
      await testConnection({
        url: form.iggyUrl.trim(),
        login: form.iggyLogin.trim(),
        password: form.iggyPassword.trim(),
      });
      setFormStatus({ kind: 'success', message: "З'єднання з Iggy успішне" });
    } catch (error) {
      setFormStatus({ kind: 'error', message: `Помилка перевірки: ${errorMessage(error)}` });
    } finally {
      setChecking(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setSaving(true);
    setPageStatus(null);
    try {
      await deleteApiIntegration(deleteTarget.id);
      setIntegrations((current) =>
        current.filter((integration) => integration.id !== deleteTarget.id),
      );
      setDeleteTarget(null);
      setPageStatus({ kind: 'success', message: 'Інтеграцію API видалено' });
    } catch (error) {
      setPageStatus({ kind: 'error', message: `Помилка видалення: ${errorMessage(error)}` });
    } finally {
      setSaving(false);
    }
  }

  if (loading && integrations.length === 0 && !loadError) {
    return <PageLoadingState minHeight="100%" />;
  }
  if (loadError && integrations.length === 0) {
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
    <Box
      className="w-full"
      sx={{
        height: { xs: 'auto', lg: '100%' },
        minHeight: 0,
        overflow: { xs: 'visible', lg: 'hidden' },
      }}
    >
      <Stack
        spacing={3}
        useFlexGap
        sx={{
          height: { xs: 'auto', lg: '100%' },
          minHeight: 0,
          overflow: { xs: 'visible', lg: 'hidden' },
        }}
      >
        {pageStatus ? (
          <PowerAlert severity={pageStatus.kind}>{pageStatus.message}</PowerAlert>
        ) : null}
        {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
        <TablePageToolbar
          title="Інтеграції API"
          titleInfo="API користувачі та параметри підключення до Apache Iggy."
          withGlobalTextFilter
          hideGlobalTextFilter={loading && integrations.length === 0}
          internalActionsDisabled={loading && integrations.length === 0}
          actions={
            <>
              <PowerButton variant="outlined" onClick={() => void load()} disabled={loading}>
                Оновити
              </PowerButton>
              <PowerButton variant="contained" onClick={openCreate} disabled={loading}>
                Додати інтеграцію
              </PowerButton>
            </>
          }
        />
        <Box sx={{ flex: 1, minHeight: { xs: 'auto', lg: 0 }, minWidth: 0, display: 'flex' }}>
          <ApiIntegrationsTable
            integrations={integrations}
            apiUsers={apiUsers}
            loading={loading || saving}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
          />
        </Box>
        <IntegrationEditorDialog
          open={editorOpen}
          form={form}
          apiUsers={apiUsers}
          busy={saving}
          checking={checking}
          status={formStatus}
          onFormChange={setForm}
          onClose={() => setEditorOpen(false)}
          onSave={() => void save()}
          onTest={() => void checkConnection()}
        />
        <Dialog open={deleteTarget !== null} onClose={() => !saving && setDeleteTarget(null)}>
          <DialogTitle>Видалити інтеграцію API?</DialogTitle>
          <DialogContent>
            <DialogContentText>
              {deleteTarget?.description ||
                apiUsers.find((user) => user.id === deleteTarget?.apiUserLoginId)?.login ||
                'Вибрана інтеграція буде видалена.'}
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <PowerButton variant="outlined" onClick={() => setDeleteTarget(null)} disabled={saving}>
              Скасувати
            </PowerButton>
            <PowerButton
              color="error"
              variant="contained"
              onClick={() => void confirmDelete()}
              disabled={saving}
            >
              Видалити
            </PowerButton>
          </DialogActions>
        </Dialog>
      </Stack>
    </Box>
  );
}

export function AdminApiIntegrationsPage() {
  return (
    <TableStateProvider
      tableId="admin-api-integrations"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <AdminApiIntegrationsPageBody />
    </TableStateProvider>
  );
}
