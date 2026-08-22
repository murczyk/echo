import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Autocomplete,
  Box,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import React from 'react';

import { Login, Organism } from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PageErrorState } from '../../components/PageErrorState';
import { PageLoadingState } from '../../components/PageLoadingState';
import { PowerButton } from '../../components/PowerButton';
import { PowerIconButton } from '../../components/PowerIconButton';
import { GoiIntegrationDrawer } from './GoiIntegrationDrawer';
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
  checkGoiConnection,
  deleteGoiAdminIntegration,
  GoiAdminIntegration,
  listGoiAdminIntegrations,
  setupGoiIntegrationWorker,
  upsertGoiAdminIntegration,
  type UpsertGoiAdminIntegrationReq,
} from '../../services/api/goi-admin';
import { listLogins } from '../../services/api/logins';
import { listOrganisms } from '../../services/api/organisms';
import { PowerAlert } from '../../components/PowerAlert';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import {
  GOI_INTEGRATION_TYPE_FULL,
  GOI_INTEGRATION_TYPE_SIMPLE,
  type GoiIntegrationType,
} from '../../services/api/organisms';
import { buildLoginOptions, selectedLoginIds, selectLoginOptions } from '../../utils/login-options';

const GOI_SSH_PORT_DEFAULT = 22;
const GOI_API_PORT_DEFAULT = 8088;
const GOI_PATH_DEFAULT = '/etc/goi/data/palettes';
const ROW_ACTIONS_COLUMN_SIZE = 76;
const DEFAULT_COLUMNS_VISIBILITY = {
  owner: true,
  server: true,
  integration_type: true,
  maintainer: true,
  worker: true,
  access: true,
};
const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'owner',
  'server',
  'integration_type',
  'maintainer',
  'worker',
  'access',
];
const defaultMRTOptions = getDefaultMRTOptions<GoiAdminIntegration>();

type StatusMessage = {
  kind: 'success' | 'error';
  message: string;
} | null;

type GoiForm = {
  id: number | null;
  ownerOrganismId: number | null;
  integrationType: GoiIntegrationType;
  sshHost: string;
  sshUser: string;
  sshPort: number;
  path: string;
  apiHost: string;
  apiPort: number;
  apiLogin: string;
  apiPassword: string;
  disableGoiToEchoPalitraSync: boolean;
  pauseWorker: boolean;
  maintainerLoginId: string;
  accessOrganismIds: number[];
  accessLogins: string[];
};

const emptyForm: GoiForm = {
  id: null,
  ownerOrganismId: null,
  integrationType: GOI_INTEGRATION_TYPE_FULL,
  sshHost: '',
  sshUser: '',
  sshPort: GOI_SSH_PORT_DEFAULT,
  path: GOI_PATH_DEFAULT,
  apiHost: '',
  apiPort: GOI_API_PORT_DEFAULT,
  apiLogin: '',
  apiPassword: '',
  disableGoiToEchoPalitraSync: true,
  pauseWorker: false,
  maintainerLoginId: '',
  accessOrganismIds: [],
  accessLogins: [],
};

function GoiIntegrationsTable({
  integrations,
  loading,
  onEdit,
  onDelete,
}: {
  integrations: GoiAdminIntegration[];
  loading: boolean;
  onEdit: (integration: GoiAdminIntegration) => void;
  onDelete: (integration: GoiAdminIntegration) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columnSizing = React.useMemo(
    () => ({
      ...tableStateContext.columnSizing,
      'mrt-row-actions': ROW_ACTIONS_COLUMN_SIZE,
    }),
    [tableStateContext.columnSizing],
  );
  const columns = React.useMemo<AppMrtColumnDef<GoiAdminIntegration>[]>(
    () => [
      { id: 'owner', header: 'Організм-власник', accessorKey: 'ownerOrganismName', size: 200 },
      { id: 'server', header: 'Сервер', accessorKey: 'serverLabel', size: 190 },
      {
        id: 'integration_type',
        header: 'Тип',
        accessorFn: (integration) =>
          integration.integrationType === GOI_INTEGRATION_TYPE_SIMPLE ? 'Проста' : 'Повна',
        size: 100,
      },
      {
        id: 'maintainer',
        header: 'Відповідальний',
        accessorFn: (integration) => integration.maintainerLoginId || '—',
        size: 180,
      },
      {
        id: 'worker',
        header: 'Воркер',
        accessorFn: (integration) => (integration.pauseWorker ? 'Призупинено' : 'Активний'),
        size: 130,
      },
      {
        id: 'access',
        header: 'Доступ',
        accessorFn: (integration) =>
          `${integration.accessOrganismIds.length} орг. / ${integration.accessLogins.length} лог.`,
        size: 150,
      },
    ],
    [],
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
        enableResizing: false,
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

  React.useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return 'Невідома помилка';
}

function asNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item));
  }
  return [];
}

function toForm(integration: GoiAdminIntegration): GoiForm {
  return {
    id: integration.id,
    ownerOrganismId: integration.ownerOrganismId,
    integrationType: integration.integrationType,
    sshHost: integration.sshHost,
    sshUser: integration.sshUser,
    sshPort: integration.sshPort,
    path: integration.path,
    apiHost: integration.apiHost,
    apiPort: integration.apiPort,
    apiLogin: integration.apiLogin,
    apiPassword: integration.apiPassword,
    disableGoiToEchoPalitraSync: integration.disableGoiToEchoPalitraSync,
    pauseWorker: integration.pauseWorker,
    maintainerLoginId: integration.maintainerLoginId,
    accessOrganismIds: integration.accessOrganismIds,
    accessLogins: integration.accessLogins,
  };
}

function hasAnyApiSettings(form: GoiForm): boolean {
  if (form.integrationType !== GOI_INTEGRATION_TYPE_FULL) return false;
  return Boolean(form.apiHost.trim() || form.apiLogin.trim() || form.apiPassword.trim());
}

function hasMaintainerLogin(form: GoiForm): boolean {
  return form.maintainerLoginId.trim().length > 0;
}

function disableGoiToEchoPalitraSyncValue(form: GoiForm): boolean {
  return hasMaintainerLogin(form) ? form.disableGoiToEchoPalitraSync : true;
}

function toSimpleGoiUrl(form: GoiForm): string {
  return form.apiHost.trim() || form.sshHost.trim();
}

function toSaveReq(form: GoiForm): UpsertGoiAdminIntegrationReq {
  if (form.integrationType === GOI_INTEGRATION_TYPE_SIMPLE) {
    return {
      id: form.id,
      ownerOrganismId: form.ownerOrganismId!,
      integrationType: GOI_INTEGRATION_TYPE_SIMPLE,
      sshHost: '',
      sshUser: '',
      sshPort: GOI_SSH_PORT_DEFAULT,
      path: GOI_PATH_DEFAULT,
      apiHost: toSimpleGoiUrl(form),
      apiPort: GOI_API_PORT_DEFAULT,
      apiLogin: '',
      apiPassword: '',
      disableGoiToEchoPalitraSync: disableGoiToEchoPalitraSyncValue(form),
      pauseWorker: form.pauseWorker,
      maintainerLoginId: form.maintainerLoginId,
      accessOrganismIds: form.accessOrganismIds,
      accessLogins: form.accessLogins,
    };
  }
  return {
    id: form.id,
    ownerOrganismId: form.ownerOrganismId!,
    integrationType: GOI_INTEGRATION_TYPE_FULL,
    sshHost: form.sshHost,
    sshUser: form.sshUser,
    sshPort: form.sshPort,
    path: form.path,
    apiHost: form.apiHost,
    apiPort: form.apiPort,
    apiLogin: form.apiLogin,
    apiPassword: form.apiPassword,
    disableGoiToEchoPalitraSync: disableGoiToEchoPalitraSyncValue(form),
    pauseWorker: form.pauseWorker,
    maintainerLoginId: form.maintainerLoginId,
    accessOrganismIds: form.accessOrganismIds,
    accessLogins: form.accessLogins,
  };
}

function validateForm(form: GoiForm): string | null {
  if (!form.ownerOrganismId) return 'Вкажіть організм-власник';
  if (!Number.isInteger(form.sshPort) || form.sshPort < 1 || form.sshPort > 65535) {
    return 'Вкажіть коректний SSH порт';
  }
  if (!Number.isInteger(form.apiPort) || form.apiPort < 1 || form.apiPort > 65535) {
    return 'Вкажіть коректний API порт';
  }
  if (form.integrationType === GOI_INTEGRATION_TYPE_SIMPLE) {
    if (!toSimpleGoiUrl(form)) {
      return 'Для простої інтеграції вкажіть GOI URL або host';
    }
    return null;
  }
  if (hasAnyApiSettings(form)) {
    if (!form.apiHost.trim() && !form.sshHost.trim()) {
      return 'Вкажіть API host або SSH host';
    }
    if (!form.apiLogin.trim()) return 'Вкажіть API логін';
    if (!form.apiPassword.trim()) return 'Вкажіть API пароль';
  }
  return null;
}

function AdminGoiIntegrationsNeoPageBody() {
  const tableStateContext = useTableStateContext();
  const [integrations, setIntegrations] = React.useState<GoiAdminIntegration[]>([]);
  const [organisms, setOrganisms] = React.useState<Organism[]>([]);
  const [logins, setLogins] = React.useState<Login[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [settingUpWorker, setSettingUpWorker] = React.useState(false);
  const [status, setStatus] = React.useState<StatusMessage>(null);
  const [form, setForm] = React.useState<GoiForm>(emptyForm);
  const initialFormRef = React.useRef<GoiForm>(emptyForm);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<GoiAdminIntegration | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextIntegrations, nextOrganisms, nextLogins] = await Promise.all([
        listGoiAdminIntegrations(),
        listOrganisms({ sortBy: 'OrganismNameAsc' }),
        listLogins({ sortBy: null, filterByRoles: null }),
      ]);
      setIntegrations(nextIntegrations);
      setOrganisms(nextOrganisms);
      setLogins(buildLoginOptions(nextLogins.users));
    } catch (error) {
      setLoadError(`Не вдалося завантажити інтеграції ГОІ: ${formatErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    void load();
  }, []);

  function openCreate() {
    setForm(emptyForm);
    initialFormRef.current = emptyForm;
    setStatus(null);
    setEditorOpen(true);
  }

  function openEdit(integration: GoiAdminIntegration) {
    const nextForm = toForm(integration);
    setForm(nextForm);
    initialFormRef.current = nextForm;
    setStatus(null);
    setEditorOpen(true);
  }

  function updateSelectedIntegration(nextIntegration: GoiAdminIntegration) {
    setIntegrations((prev) => {
      const exists = prev.some((item) => item.id === nextIntegration.id);
      const next = exists
        ? prev.map((item) => (item.id === nextIntegration.id ? nextIntegration : item))
        : [nextIntegration, ...prev];
      return next.sort((a, b) => a.serverLabel.localeCompare(b.serverLabel, 'uk'));
    });
    setForm(toForm(nextIntegration));
  }

  function handleIntegrationTypeChange(integrationType: GoiIntegrationType) {
    setForm((prev) => {
      if (integrationType === GOI_INTEGRATION_TYPE_SIMPLE) {
        return {
          ...prev,
          integrationType,
          sshHost: '',
          sshUser: '',
          sshPort: GOI_SSH_PORT_DEFAULT,
          path: GOI_PATH_DEFAULT,
          apiHost: toSimpleGoiUrl(prev),
          apiPort: GOI_API_PORT_DEFAULT,
          apiLogin: '',
          apiPassword: '',
        };
      }
      return { ...prev, integrationType };
    });
  }

  async function handleSave() {
    const validationError = validateForm(form);
    if (validationError) {
      setStatus({ kind: 'error', message: validationError });
      return;
    }

    setSaving(true);
    setStatus(null);
    try {
      const saved = await upsertGoiAdminIntegration(toSaveReq(form));
      updateSelectedIntegration(saved);
      setEditorOpen(false);
      setStatus({ kind: 'success', message: 'Інтеграцію ГОІ збережено' });
    } catch (error) {
      setStatus({ kind: 'error', message: `Помилка збереження: ${formatErrorMessage(error)}` });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setSaving(true);
    setStatus(null);
    try {
      await deleteGoiAdminIntegration(deleteTarget.id);
      setIntegrations((current) => current.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
      setStatus({ kind: 'success', message: 'Інтеграцію ГОІ видалено' });
    } catch (error) {
      setStatus({ kind: 'error', message: `Помилка видалення: ${formatErrorMessage(error)}` });
    } finally {
      setSaving(false);
    }
  }

  async function handleCheckConnection() {
    setChecking(true);
    setStatus(null);
    try {
      const response = await checkGoiConnection({
        sshHost: form.sshHost.trim(),
        sshUser: form.sshUser.trim(),
        sshPort: form.sshPort,
        path: form.path.trim() || '/etc/goi/data/palettes',
      });
      if (!response.ok || response.error) {
        setStatus({
          kind: 'error',
          message: response.error || "Помилка перевірки з'єднання",
        });
        return;
      }
      setStatus({
        kind: 'success',
        message:
          response.listedEntries.length > 0
            ? `З'єднання успішне. Файли: ${response.listedEntries.slice(0, 5).join(', ')}`
            : "З'єднання успішне. Каталог доступний.",
      });
    } catch (error) {
      setStatus({ kind: 'error', message: `Помилка перевірки: ${formatErrorMessage(error)}` });
    } finally {
      setChecking(false);
    }
  }

  async function handleSetupWorker() {
    if (!form.id) return;
    setSettingUpWorker(true);
    setStatus(null);
    try {
      const saved = await setupGoiIntegrationWorker({
        id: form.id,
        sshHost: form.sshHost.trim(),
        sshUser: form.sshUser.trim(),
        sshPort: form.sshPort,
        path: form.path.trim() || '/etc/goi/data/palettes',
        apiHost: form.apiHost.trim() || form.sshHost.trim(),
        apiPort: form.apiPort,
      });
      updateSelectedIntegration(saved);
      setStatus({
        kind: 'success',
        message:
          "Воркер налаштовано. Логін 'goi' і згенерований пароль записані на інстансі та повернуті у форму.",
      });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: `Помилка налаштування воркера: ${formatErrorMessage(error)}`,
      });
    } finally {
      setSettingUpWorker(false);
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

  const ownerOptions = organisms;
  const selectedOwner = ownerOptions.find((item) => item.id === form.ownerOrganismId) ?? null;
  const isGoiToEchoPalitraSyncToggleDisabled = !hasMaintainerLogin(form);
  const editorBusy = saving || checking || settingUpWorker;
  const closeEditor = () => {
    if (editorBusy) return;
    if (
      JSON.stringify(form) !== JSON.stringify(initialFormRef.current) &&
      !window.confirm('Є незбережені зміни. Закрити форму?')
    )
      return;
    setEditorOpen(false);
  };

  return (
    <Box
      className="w-full"
      sx={{
        height: '100%',
        minHeight: 0,
        p: 2,
        boxSizing: 'border-box',
        overflow: { xs: 'visible', lg: 'hidden' },
      }}
    >
      <Stack
        spacing={1.5}
        useFlexGap
        sx={{
          height: { xs: 'auto', lg: '100%' },
          minHeight: 0,
          overflow: { xs: 'visible', lg: 'hidden' },
        }}
      >
        {status && !editorOpen ? (
          <PowerAlert severity={status.kind}>{status.message}</PowerAlert>
        ) : null}
        {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
        <TablePageToolbar
          title="ГОІ"
          titleInfo="Інтеграції ГОІ з власником, доступом для організмів і логінів та керуванням worker/SSH."
          withGlobalTextFilter
          hideGlobalTextFilter={loading && integrations.length === 0}
          internalActionsDisabled={loading && integrations.length === 0}
          actions={
            <PowerButton variant="contained" onClick={openCreate} disabled={loading}>
              Додати інтеграцію
            </PowerButton>
          }
          additionalInternalActions={
            <Tooltip title="Оновити">
              <span>
                <PowerIconButton
                  aria-label="Оновити"
                  size="small"
                  onClick={() => void load()}
                  disabled={loading}
                >
                  <RefreshIcon fontSize="small" />
                </PowerIconButton>
              </span>
            </Tooltip>
          }
        />
        <Box sx={{ flex: 1, minHeight: { xs: 'auto', lg: 0 }, minWidth: 0, display: 'flex' }}>
          <GoiIntegrationsTable
            integrations={integrations}
            loading={loading || saving || checking || settingUpWorker}
            onEdit={openEdit}
            onDelete={setDeleteTarget}
          />
        </Box>

        <GoiIntegrationDrawer
          open={editorOpen}
          title={form.id ? 'Редагувати інтеграцію ГОІ' : 'Створити інтеграцію ГОІ'}
          busy={editorBusy}
          onClose={closeEditor}
          footer={
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <PowerButton variant="outlined" onClick={closeEditor} disabled={editorBusy}>
                Скасувати
              </PowerButton>
              {form.integrationType === GOI_INTEGRATION_TYPE_FULL ? (
                <PowerButton
                  variant="outlined"
                  onClick={handleCheckConnection}
                  disabled={editorBusy}
                >
                  Перевірити з'єднання
                </PowerButton>
              ) : null}
              {form.id && form.integrationType === GOI_INTEGRATION_TYPE_FULL ? (
                <PowerButton variant="outlined" onClick={handleSetupWorker} disabled={editorBusy}>
                  Налаштувати воркер
                </PowerButton>
              ) : null}
              <PowerButton variant="contained" onClick={handleSave} disabled={editorBusy}>
                {form.id ? 'Зберегти' : 'Створити'}
              </PowerButton>
            </Stack>
          }
        >
          <Stack spacing={3}>
            {status ? <PowerAlert severity={status.kind}>{status.message}</PowerAlert> : null}

            <Autocomplete
              options={ownerOptions}
              value={selectedOwner}
              onChange={(_, option) =>
                setForm((prev) => ({ ...prev, ownerOrganismId: option?.id ?? null }))
              }
              getOptionLabel={(option) => option.name || `ID ${option.id}`}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              renderOption={(props, option) => (
                <li {...props} key={option.id}>
                  {option.name || `ID ${option.id}`}
                </li>
              )}
              renderInput={(params) => <TextField {...params} label="Організм-власник" fullWidth />}
            />

            <TextField
              select
              label="Тип інтеграції"
              value={form.integrationType}
              onChange={(event) =>
                handleIntegrationTypeChange(event.target.value as GoiIntegrationType)
              }
              fullWidth
            >
              <MenuItem value={GOI_INTEGRATION_TYPE_SIMPLE}>Проста</MenuItem>
              <MenuItem value={GOI_INTEGRATION_TYPE_FULL}>Повна</MenuItem>
            </TextField>

            <Autocomplete
              options={logins}
              value={
                form.maintainerLoginId
                  ? selectLoginOptions([form.maintainerLoginId], logins)[0]
                  : null
              }
              onChange={(_, value) =>
                setForm((prev) => ({
                  ...prev,
                  maintainerLoginId: value?.id ?? '',
                  disableGoiToEchoPalitraSync: value ? prev.disableGoiToEchoPalitraSync : true,
                }))
              }
              getOptionLabel={(option) => option.login}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              renderOption={(props, option) => {
                const { key: _unusedKey, ...optionProps } = props;
                return (
                  <li {...optionProps} key={option.id}>
                    {option.login}
                  </li>
                );
              }}
              renderInput={(params) => (
                <TextField {...params} label="Відповідальний логін" fullWidth />
              )}
            />

            <Stack spacing={1}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={
                      isGoiToEchoPalitraSyncToggleDisabled ? true : form.disableGoiToEchoPalitraSync
                    }
                    disabled={isGoiToEchoPalitraSyncToggleDisabled}
                    onChange={(event) =>
                      setForm((prev) => ({
                        ...prev,
                        disableGoiToEchoPalitraSync: event.target.checked,
                      }))
                    }
                  />
                }
                label="Вимкнути перенесення палітр з ГОІ в Echo"
              />
              {isGoiToEchoPalitraSyncToggleDisabled ? (
                <PowerAlert severity="warning">
                  Щоб увімкнути перенесення палітр з ГОІ в Echo, спочатку призначте окремий
                  відповідальний логін для цієї інтеграції. Зверніться до адміністратора, щоб
                  увімкнути цю можливість.
                </PowerAlert>
              ) : null}
            </Stack>

            <FormControlLabel
              control={
                <Checkbox
                  checked={form.pauseWorker}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      pauseWorker: event.target.checked,
                    }))
                  }
                />
              }
              label="Призупинити воркер"
            />

            {form.integrationType === GOI_INTEGRATION_TYPE_SIMPLE ? (
              <TextField
                label="GOI URL"
                value={form.apiHost}
                onChange={(event) => setForm((prev) => ({ ...prev, apiHost: event.target.value }))}
                fullWidth
              />
            ) : (
              <>
                <TextField
                  label="SSH host"
                  value={form.sshHost}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, sshHost: event.target.value }))
                  }
                  fullWidth
                />
                <TextField
                  label="SSH user"
                  value={form.sshUser}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, sshUser: event.target.value }))
                  }
                  fullWidth
                />
                <TextField
                  label="SSH порт"
                  type="number"
                  value={form.sshPort}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      sshPort: Number(event.target.value) || GOI_SSH_PORT_DEFAULT,
                    }))
                  }
                  fullWidth
                />
                <TextField
                  label="Шлях до палітр"
                  value={form.path}
                  onChange={(event) => setForm((prev) => ({ ...prev, path: event.target.value }))}
                  fullWidth
                />
                <TextField
                  label="API host"
                  value={form.apiHost}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, apiHost: event.target.value }))
                  }
                  fullWidth
                />
                <TextField
                  label="API порт"
                  type="number"
                  value={form.apiPort}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      apiPort: Number(event.target.value) || GOI_API_PORT_DEFAULT,
                    }))
                  }
                  fullWidth
                />
                <TextField
                  label="API логін"
                  value={form.apiLogin}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, apiLogin: event.target.value }))
                  }
                  fullWidth
                />
                <TextField
                  label="API пароль"
                  type="password"
                  value={form.apiPassword}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, apiPassword: event.target.value }))
                  }
                  fullWidth
                />
              </>
            )}

            <TextField
              select
              label="Доступ для організмів"
              value={form.accessOrganismIds}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  accessOrganismIds: asNumberArray(event.target.value),
                }))
              }
              SelectProps={{
                multiple: true,
                renderValue: (selected) =>
                  (selected as number[])
                    .map((id) => organisms.find((item) => item.id === id)?.name || String(id))
                    .join(', ') || '—',
              }}
              fullWidth
            >
              {organisms.map((organism) => (
                <MenuItem key={organism.id} value={organism.id}>
                  {organism.name}
                </MenuItem>
              ))}
            </TextField>

            <Autocomplete
              multiple
              options={logins}
              value={selectLoginOptions(form.accessLogins, logins)}
              onChange={(_, values) =>
                setForm((prev) => ({ ...prev, accessLogins: selectedLoginIds(values) }))
              }
              getOptionLabel={(option) => option.login}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              renderOption={(props, option) => {
                const { key: _unusedKey, ...optionProps } = props;
                return (
                  <li {...optionProps} key={option.id}>
                    {option.login}
                  </li>
                );
              }}
              renderInput={(params) => (
                <TextField {...params} label="Доступ для логінів" fullWidth />
              )}
            />
          </Stack>
        </GoiIntegrationDrawer>
        <Dialog open={deleteTarget !== null} onClose={() => !saving && setDeleteTarget(null)}>
          <DialogTitle>Видалити інтеграцію ГОІ?</DialogTitle>
          <DialogContent>
            <DialogContentText>
              {deleteTarget
                ? `${deleteTarget.ownerOrganismName} / ${deleteTarget.serverLabel}`
                : ''}
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <PowerButton variant="outlined" onClick={() => setDeleteTarget(null)} disabled={saving}>
              Скасувати
            </PowerButton>
            <PowerButton color="error" variant="contained" onClick={handleDelete} disabled={saving}>
              Видалити
            </PowerButton>
          </DialogActions>
        </Dialog>
      </Stack>
    </Box>
  );
}

export function AdminGoiIntegrationsNeoPage() {
  return (
    <TableStateProvider
      tableId="admin-goi-integrations"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <AdminGoiIntegrationsNeoPageBody />
    </TableStateProvider>
  );
}
