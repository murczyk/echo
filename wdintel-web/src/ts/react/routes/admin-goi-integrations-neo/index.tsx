import {
  Alert,
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
import { Button } from '../../components/mui-customized/button';
import {
  checkGoiConnection,
  deleteGoiAdminIntegration,
  GoiAdminIntegration,
  listGoiAdminIntegrations,
  setupGoiIntegrationWorker,
  upsertGoiAdminIntegration,
} from '../../services/api/goi-admin';
import { listLogins } from '../../services/api/logins';
import { listOrganisms } from '../../services/api/organisms';
import {
  GOI_INTEGRATION_TYPE_FULL,
  GOI_INTEGRATION_TYPE_SIMPLE,
  type GoiIntegrationType,
} from '../../services/api/organisms';

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
  sshPort: 22,
  path: '/etc/goi/data/palettes',
  apiHost: '',
  apiPort: 8088,
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
    return value
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item));
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

function validateForm(form: GoiForm): string | null {
  if (!form.ownerOrganismId) return 'Вкажіть організм-власник';
  if (!Number.isInteger(form.sshPort) || form.sshPort < 1 || form.sshPort > 65535) {
    return 'Вкажіть коректний SSH порт';
  }
  if (!Number.isInteger(form.apiPort) || form.apiPort < 1 || form.apiPort > 65535) {
    return 'Вкажіть коректний API порт';
  }
  if (form.integrationType === GOI_INTEGRATION_TYPE_SIMPLE) {
    if (!form.apiHost.trim() && !form.sshHost.trim()) {
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
        setLogins(nextLogins.users.map((user) => user.login));
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

  async function handleSave() {
    const validationError = validateForm(form);
    if (validationError) {
      setStatus({ kind: 'error', message: validationError });
      return;
    }

    setSaving(true);
    setStatus(null);
    try {
      const saved = await upsertGoiAdminIntegration({
        id: form.id,
        ownerOrganismId: form.ownerOrganismId!,
        integrationType: form.integrationType,
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
      });
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
      setStatus({ kind: 'error', message: `Помилка налаштування воркера: ${formatErrorMessage(error)}` });
    } finally {
      setSettingUpWorker(false);
    }
  }

  if (loading) {
    return <Alert severity="info">Завантажую інтеграції ГОІ...</Alert>;
  }

  const ownerOptions = organisms;
  const selectedOwner = ownerOptions.find((item) => item.id === form.ownerOrganismId) ?? null;

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Адмін: ГОІ"
        titleInfo="Окремі інтеграції ГОІ з власником, доступом для організмів і логінів, та керуванням worker/SSH."
      />

      {status ? <Alert severity={status.kind}>{status.message}</Alert> : null}

      <Card variant="outlined">
        <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
          <Stack spacing={2}>
            <div className="flex flex-wrap gap-2">
              <Button variant="contained" onClick={() => selectIntegration(null)} disabled={saving || checking || settingUpWorker}>
                Нова інтеграція
              </Button>
              {saving || checking || settingUpWorker ? <CircularProgress size={18} /> : null}
            </div>
            {integrations.length === 0 ? (
              <Alert severity="info">Інтеграцій ГОІ ще немає.</Alert>
            ) : (
              <div className="flex flex-wrap gap-2">
                {integrations.map((integration) => (
                  <Button
                    key={integration.id}
                    variant={integration.id === selectedId ? 'contained' : 'outlined'}
                    onClick={() => selectIntegration(integration.id)}
                  >
                    {integration.ownerOrganismName} / {integration.serverLabel}
                  </Button>
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
              onChange={(_, option) => setForm((prev) => ({ ...prev, ownerOrganismId: option?.id ?? null }))}
              getOptionLabel={(option) => option.name || `ID ${option.id}`}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              renderInput={(params) => <TextField {...params} label="Організм-власник" fullWidth />}
            />

            <TextField
              select
              label="Тип інтеграції"
              value={form.integrationType}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  integrationType: event.target.value as GoiIntegrationType,
                }))
              }
              fullWidth
            >
              <MenuItem value={GOI_INTEGRATION_TYPE_SIMPLE}>Проста</MenuItem>
              <MenuItem value={GOI_INTEGRATION_TYPE_FULL}>Повна</MenuItem>
            </TextField>

            <TextField label="SSH host" value={form.sshHost} onChange={(event) => setForm((prev) => ({ ...prev, sshHost: event.target.value }))} fullWidth />
            <TextField label="SSH user" value={form.sshUser} onChange={(event) => setForm((prev) => ({ ...prev, sshUser: event.target.value }))} fullWidth />
            <TextField label="SSH порт" type="number" value={form.sshPort} onChange={(event) => setForm((prev) => ({ ...prev, sshPort: Number(event.target.value) || 22 }))} fullWidth />
            <TextField label="Шлях до палітр" value={form.path} onChange={(event) => setForm((prev) => ({ ...prev, path: event.target.value }))} fullWidth />
            <TextField label="API host / GOI URL" value={form.apiHost} onChange={(event) => setForm((prev) => ({ ...prev, apiHost: event.target.value }))} fullWidth />
            <TextField label="API порт" type="number" value={form.apiPort} onChange={(event) => setForm((prev) => ({ ...prev, apiPort: Number(event.target.value) || 8088 }))} fullWidth />
            <TextField label="API логін" value={form.apiLogin} onChange={(event) => setForm((prev) => ({ ...prev, apiLogin: event.target.value }))} fullWidth />
            <TextField label="API пароль" type="password" value={form.apiPassword} onChange={(event) => setForm((prev) => ({ ...prev, apiPassword: event.target.value }))} fullWidth />

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
              renderInput={(params) => <TextField {...params} label="Доступ для логінів" fullWidth />}
            />
          </Stack>
        </CardContent>
        <CardActions sx={{ px: 3, pb: 3, gap: 1, flexWrap: 'wrap' }}>
          <Button variant="contained" onClick={handleSave} disabled={saving || checking || settingUpWorker}>
            {form.id ? 'Зберегти' : 'Створити'}
          </Button>
          <Button variant="outlined" onClick={handleCheckConnection} disabled={saving || checking || settingUpWorker}>
            Перевірити з'єднання
          </Button>
          {form.id ? (
            <Button variant="outlined" onClick={handleSetupWorker} disabled={saving || checking || settingUpWorker}>
              Налаштувати воркер
            </Button>
          ) : null}
          {form.id ? (
            <Button variant="outlined" color="error" onClick={handleDelete} disabled={saving || checking || settingUpWorker}>
              Видалити
            </Button>
          ) : null}
        </CardActions>
      </Card>
    </Stack>
  );
}
