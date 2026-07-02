import {
  Autocomplete,
  Card,
  CardActions,
  CardContent,
  CircularProgress,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import React from 'react';

import { ApiIntegration, Login, UpsertApiIntegrationReq } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import {
  deleteApiIntegration,
  listApiIntegrations,
  testConnection,
  upsertApiIntegration,
} from '../../services/api/api-integrations';
import { listLogins } from '../../services/api/logins';

type StatusMessage = {
  kind: 'success' | 'error';
  message: string;
} | null;

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

const emptyForm: ApiIntegrationForm = {
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

function toForm(integration: ApiIntegration): ApiIntegrationForm {
  return {
    id: integration.id,
    description: integration.description ?? '',
    apiUser: integration.apiUser,
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
    apiUser: form.apiUser,
    hasIggyConnection: form.hasIggyConnection,
    iggyUrl: iggyValue(form.iggyUrl),
    iggyLogin: iggyValue(form.iggyLogin),
    iggyPassword: iggyValue(form.iggyPassword),
    iggyInboxTopic: iggyValue(form.iggyInboxTopic),
    iggyAnalyticsTopic: iggyValue(form.iggyAnalyticsTopic),
    syncEnabled: form.id !== null && form.syncEnabled,
  };
}

function validateForm(form: ApiIntegrationForm): string | null {
  if (!form.apiUser.trim()) return 'Вкажіть API користувача';
  if (!form.hasIggyConnection) return null;
  const connectionError = validateIggyConnection(form);
  if (connectionError) return connectionError;
  if (!form.iggyInboxTopic.trim()) return 'Вкажіть тему для вхідних повідомлень';
  if (!form.iggyAnalyticsTopic.trim()) return 'Вкажіть тему для аналітичної інформації';
  return null;
}

function validateIggyConnection(form: ApiIntegrationForm): string | null {
  if (!form.iggyUrl.trim()) return 'Вкажіть Iggy URL';
  if (!form.iggyLogin.trim()) return 'Вкажіть Iggy логін';
  if (!form.iggyPassword.trim()) return 'Вкажіть Iggy пароль';
  return null;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Невідома помилка';
}

export function AdminApiIntegrationsPage() {
  const [integrations, setIntegrations] = React.useState<ApiIntegration[]>([]);
  const [apiUsers, setApiUsers] = React.useState<Login[]>([]);
  const [form, setForm] = React.useState<ApiIntegrationForm>(emptyForm);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [status, setStatus] = React.useState<StatusMessage>(null);

  React.useEffect(() => {
    void (async () => {
      try {
        const [nextIntegrations, logins] = await Promise.all([
          listApiIntegrations(),
          listLogins({ sortBy: null, filterByRoles: ['Api'] }),
        ]);
        setIntegrations(nextIntegrations);
        setApiUsers(logins.users.sort((a, b) => a.login.localeCompare(b.login, 'uk')));
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
    const integration = integrations.find((item) => item.id === id);
    setSelectedId(id);
    setForm(integration ? toForm(integration) : emptyForm);
    setStatus(null);
  }

  function updateSelectedIntegration(integration: ApiIntegration) {
    setIntegrations((previous) => {
      const exists = previous.some((item) => item.id === integration.id);
      return exists
        ? previous.map((item) => (item.id === integration.id ? integration : item))
        : [integration, ...previous];
    });
    setSelectedId(integration.id);
    setForm(toForm(integration));
  }

  function setHasIggyConnection(hasIggyConnection: boolean) {
    setForm((previous) => ({
      ...previous,
      hasIggyConnection,
      iggyUrl: hasIggyConnection ? previous.iggyUrl : '',
      iggyLogin: hasIggyConnection ? previous.iggyLogin : '',
      iggyPassword: hasIggyConnection ? previous.iggyPassword : '',
      iggyInboxTopic: hasIggyConnection ? previous.iggyInboxTopic : '',
      iggyAnalyticsTopic: hasIggyConnection ? previous.iggyAnalyticsTopic : '',
      syncEnabled: hasIggyConnection ? previous.syncEnabled : false,
    }));
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
      const integration = await upsertApiIntegration(toSaveReq(form));
      updateSelectedIntegration(integration);
      setStatus({ kind: 'success', message: 'API інтеграцію збережено' });
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
      await deleteApiIntegration(form.id);
      const nextIntegrations = integrations.filter((item) => item.id !== form.id);
      setIntegrations(nextIntegrations);
      const next = nextIntegrations[0];
      setSelectedId(next?.id ?? null);
      setForm(next ? toForm(next) : emptyForm);
      setStatus({ kind: 'success', message: 'API інтеграцію видалено' });
    } catch (error) {
      setStatus({ kind: 'error', message: `Помилка видалення: ${formatErrorMessage(error)}` });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    const validationError = validateIggyConnection(form);
    if (validationError) {
      setStatus({ kind: 'error', message: validationError });
      return;
    }
    setChecking(true);
    setStatus(null);
    try {
      await testConnection({
        url: form.iggyUrl.trim(),
        login: form.iggyLogin.trim(),
        password: form.iggyPassword.trim(),
      });
      setStatus({ kind: 'success', message: "З'єднання з Iggy успішне" });
    } catch (error) {
      setStatus({ kind: 'error', message: `Помилка перевірки: ${formatErrorMessage(error)}` });
    } finally {
      setChecking(false);
    }
  }

  if (loading) return <PowerAlert severity="info">Завантажую API інтеграції...</PowerAlert>;

  const selectedApiUser = apiUsers.find((user) => user.login === form.apiUser) ?? null;
  const disabled = saving || checking;

  return (
    <Stack spacing={3}>
      <PageHeader
        title="Адмін: API Інтеграції"
        titleInfo="API користувачі та параметри підключення до Apache Iggy."
      />

      {status ? <PowerAlert severity={status.kind}>{status.message}</PowerAlert> : null}

      <Card variant="outlined">
        <CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
          <Stack spacing={2}>
            <div className="flex flex-wrap gap-2">
              <PowerButton
                variant="contained"
                onClick={() => selectIntegration(null)}
                disabled={disabled}
              >
                Нова інтеграція
              </PowerButton>
              {disabled ? <CircularProgress size={18} /> : null}
            </div>
            {integrations.length === 0 ? (
              <PowerAlert severity="info">API інтеграцій ще немає.</PowerAlert>
            ) : (
              <div className="flex flex-wrap gap-2">
                {integrations.map((integration) => (
                  <PowerButton
                    key={integration.id}
                    variant={integration.id === selectedId ? 'contained' : 'outlined'}
                    onClick={() => selectIntegration(integration.id)}
                  >
                    {integration.description || integration.apiUser}
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
              {form.id ? `API інтеграція #${form.id}` : 'Нова API інтеграція'}
            </Typography>

            <TextField
              label="Опис"
              value={form.description}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, description: event.target.value }))
              }
              multiline
              minRows={2}
              fullWidth
            />

            <Autocomplete
              options={apiUsers}
              value={selectedApiUser}
              onChange={(_, option) =>
                setForm((previous) => ({ ...previous, apiUser: option?.login ?? '' }))
              }
              getOptionLabel={(option) => option.login}
              isOptionEqualToValue={(option, value) => option.login === value.login}
              renderInput={(params) => (
                <TextField {...params} label="API користувач" required fullWidth />
              )}
            />

            <FormControlLabel
              control={
                <Switch
                  checked={form.hasIggyConnection}
                  onChange={(event) => setHasIggyConnection(event.target.checked)}
                />
              }
              label="Є підключення до Iggy"
            />

            {form.id ? (
              <FormControlLabel
                control={
                  <Switch
                    checked={form.syncEnabled}
                    onChange={(event) =>
                      setForm((previous) => ({
                        ...previous,
                        syncEnabled: event.target.checked,
                      }))
                    }
                    disabled={!form.hasIggyConnection}
                  />
                }
                label="Увімкнути синхронізацію"
              />
            ) : null}

            <TextField
              label="Iggy URL"
              value={form.iggyUrl}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, iggyUrl: event.target.value }))
              }
              placeholder="iggy://localhost:8090"
              disabled={!form.hasIggyConnection}
              required={form.hasIggyConnection}
              fullWidth
            />
            <TextField
              label="Iggy логін"
              value={form.iggyLogin}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, iggyLogin: event.target.value }))
              }
              disabled={!form.hasIggyConnection}
              required={form.hasIggyConnection}
              fullWidth
            />
            <TextField
              label="Iggy пароль"
              type="password"
              value={form.iggyPassword}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, iggyPassword: event.target.value }))
              }
              disabled={!form.hasIggyConnection}
              required={form.hasIggyConnection}
              fullWidth
            />
            <TextField
              label="Назва топіку для надсилання вхідних повідомлень"
              value={form.iggyInboxTopic}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, iggyInboxTopic: event.target.value }))
              }
              disabled={!form.hasIggyConnection}
              required={form.hasIggyConnection}
              fullWidth
            />
            <TextField
              label="Назва топіку для отримання аналітичної інформації"
              value={form.iggyAnalyticsTopic}
              onChange={(event) =>
                setForm((previous) => ({ ...previous, iggyAnalyticsTopic: event.target.value }))
              }
              disabled={!form.hasIggyConnection}
              required={form.hasIggyConnection}
              fullWidth
            />
          </Stack>
        </CardContent>
        <CardActions sx={{ px: 3, pb: 3, gap: 1, flexWrap: 'wrap' }}>
          <PowerButton variant="contained" onClick={handleSave} disabled={disabled}>
            {form.id ? 'Зберегти' : 'Створити'}
          </PowerButton>
          {form.hasIggyConnection ? (
            <PowerButton variant="outlined" onClick={handleTestConnection} disabled={disabled}>
              Перевірити з'єднання з Iggy
            </PowerButton>
          ) : null}
          {form.id ? (
            <PowerButton
              variant="outlined"
              color="error"
              onClick={handleDelete}
              disabled={disabled}
            >
              Видалити
            </PowerButton>
          ) : null}
        </CardActions>
      </Card>
    </Stack>
  );
}
