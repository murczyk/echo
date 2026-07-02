import {
  Autocomplete,
  Card,
  CardActions,
  CardContent,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';

import { Organism } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PowerButton } from '../../components/PowerButton';
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
import {
  GOI_INTEGRATION_TYPE_FULL,
  GOI_INTEGRATION_TYPE_SIMPLE,
  type GoiIntegrationType,
} from '../../services/api/organisms';

const GOI_SSH_PORT_DEFAULT = 22;
const GOI_API_PORT_DEFAULT = 8088;
const GOI_PATH_DEFAULT = '/etc/goi/data/palettes';

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
  accessOrganismIds: [],
  accessLogins: [],
};

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
    accessOrganismIds: integration.accessOrganismIds,
    accessLogins: integration.accessLogins,
  };
}

function hasAnyApiSettings(form: GoiForm): boolean {
  if (form.integrationType !== GOI_INTEGRATION_TYPE_FULL) return false;
  return Boolean(form.apiHost.trim() || form.apiLogin.trim() || form.apiPassword.trim());
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

export function AdminGoiIntegrationsNeoPage() {
  const [integrations, setIntegrations] = React.useState<GoiAdminIntegration[]>([]);
  const [organisms, setOrganisms] = React.useState<Organism[]>([]);
  const [logins, setLogins] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [settingUpWorker, setSettingUpWorker] = React.useState(false);
  const [status, setStatus] = React.useState<StatusMessage>(null);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [form, setForm] = React.useState<GoiForm>(emptyForm);

  React.useEffect(() => {
    void (async () => {
      try {
        const [nextIntegrations, nextOrganisms, nextLogins] = await Promise.all([
          listGoiAdminIntegrations(),
          listOrganisms({ sortBy: 'OrganismNameAsc' }),
          listLogins({ sortBy: null, filterByRoles: null }),
        ]);
        setIntegrations(nextIntegrations);
        setOrganisms(nextOrganisms);
        setLogins(
          Array.from(new Set(nextLogins.users.map((user) => user.login))).sort((a, b) =>
            a.localeCompare(b, 'uk'),
          ),
        );
        if (nextIntegrations.length > 0) {
          setSelectedId(nextIntegrations[0].id);
          setForm(toForm(nextIntegrations[0]));
        }
      } catch (error) {
        setStatus({ kind: 'error', message: `Помилка завантаження: ${formatErrorMessage(error)}` });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function selectIntegration(id: number | null) {
    setSelectedId(id);
    const integration = integrations.find((item) => item.id === id);
    setForm(integration ? toForm(integration) : emptyForm);
    setStatus(null);
  }

  function updateSelectedIntegration(nextIntegration: GoiAdminIntegration) {
    setIntegrations((prev) => {
      const exists = prev.some((item) => item.id === nextIntegration.id);
      const next = exists
        ? prev.map((item) => (item.id === nextIntegration.id ? nextIntegration : item))
        : [nextIntegration, ...prev];
      return next.sort((a, b) => a.serverLabel.localeCompare(b.serverLabel, 'uk'));
    });
    setSelectedId(nextIntegration.id);
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
      setStatus({ kind: 'success', message: 'Інтеграцію ГОІ збережено' });
    } catch (error) {
      setStatus({ kind: 'error', message: `Помилка збереження: ${formatErrorMessage(error)}` });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!form.id) return;
    setSaving(true);
    setStatus(null);
    try {
      await deleteGoiAdminIntegration(form.id);
      const nextIntegrations = integrations.filter((item) => item.id !== form.id);
      setIntegrations(nextIntegrations);
      if (nextIntegrations.length > 0) {
        selectIntegration(nextIntegrations[0].id);
      } else {
        selectIntegration(null);
      }
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

  if (loading) {
    return <PowerAlert severity="info">Завантажую інтеграції ГОІ...</PowerAlert>;
  }

  const ownerOptions = organisms;
  const selectedOwner = ownerOptions.find((item) => item.id === form.ownerOrganismId) ?? null;

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Адмін: ГОІ"
        titleInfo="Окремі інтеграції ГОІ з власником, доступом для організмів і логінів, та керуванням worker/SSH."
      />

      {status ? <PowerAlert severity={status.kind}>{status.message}</PowerAlert> : null}

      <Card variant="outlined">
        <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
          <Stack spacing={2}>
            <div className="flex flex-wrap gap-2">
              <PowerButton
                variant="contained"
                onClick={() => selectIntegration(null)}
                disabled={saving || checking || settingUpWorker}
              >
                Нова інтеграція
              </PowerButton>
              {saving || checking || settingUpWorker ? <CircularProgress size={18} /> : null}
            </div>
            {integrations.length === 0 ? (
              <PowerAlert severity="info">Інтеграцій ГОІ ще немає.</PowerAlert>
            ) : (
              <div className="flex flex-wrap gap-2">
                {integrations.map((integration) => (
                  <PowerButton
                    key={integration.id}
                    variant={integration.id === selectedId ? 'contained' : 'outlined'}
                    onClick={() => selectIntegration(integration.id)}
                  >
                    {integration.ownerOrganismName} / {integration.serverLabel}
                  </PowerButton>
                ))}
              </div>
            )}
          </Stack>
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
          <Stack spacing={3}>
            <Typography variant="h6" className="!font-semibold">
              {form.id ? `Інтеграція #${form.id}` : 'Нова інтеграція'}
            </Typography>

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
              value={form.accessLogins}
              onChange={(_, values) => setForm((prev) => ({ ...prev, accessLogins: values }))}
              renderOption={(props, option) => (
                <li {...props} key={option}>
                  {option}
                </li>
              )}
              renderInput={(params) => (
                <TextField {...params} label="Доступ для логінів" fullWidth />
              )}
            />
          </Stack>
        </CardContent>
        <CardActions sx={{ px: 3, pb: 3, gap: 1, flexWrap: 'wrap' }}>
          <PowerButton
            variant="contained"
            onClick={handleSave}
            disabled={saving || checking || settingUpWorker}
          >
            {form.id ? 'Зберегти' : 'Створити'}
          </PowerButton>
          {form.integrationType === GOI_INTEGRATION_TYPE_FULL ? (
            <PowerButton
              variant="outlined"
              onClick={handleCheckConnection}
              disabled={saving || checking || settingUpWorker}
            >
              Перевірити з'єднання
            </PowerButton>
          ) : null}
          {form.id && form.integrationType === GOI_INTEGRATION_TYPE_FULL ? (
            <PowerButton
              variant="outlined"
              onClick={handleSetupWorker}
              disabled={saving || checking || settingUpWorker}
            >
              Налаштувати воркер
            </PowerButton>
          ) : null}
          {form.id ? (
            <PowerButton
              variant="outlined"
              color="error"
              onClick={handleDelete}
              disabled={saving || checking || settingUpWorker}
            >
              Видалити
            </PowerButton>
          ) : null}
        </CardActions>
      </Card>
    </Stack>
  );
}
