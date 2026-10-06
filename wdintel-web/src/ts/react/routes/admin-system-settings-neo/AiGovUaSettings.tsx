import {
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';

import type { AiGovUaSettingsRsp } from '../../../../Bindings';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  getAiGovUaSettings,
  listAiGovUaModels,
  saveAiGovUaSettings,
} from '../../services/api/ai-engines';

export function AiGovUaSettings() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<AiGovUaSettingsRsp | null>(null);
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const { notify } = usePowerSnackbar();

  function showError(error: unknown) {
    notify({ severity: 'error', message: error instanceof Error ? error.message : String(error) });
  }

  function close() {
    if (busy) return;
    setSecret('');
    setOpen(false);
  }

  async function load() {
    setOpen(true);
    setBusy(true);
    setSettings(null);
    setSecret('');
    setClearSecret(false);
    setModels([]);
    try {
      setSettings(await getAiGovUaSettings());
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!settings) return;
    setBusy(true);
    try {
      setSettings(
        await saveAiGovUaSettings({
          enabled: settings.enabled,
          tenantId: settings.tenantId,
          clientId: settings.clientId,
          scope: settings.scope,
          clientSecret: secret || null,
          clearClientSecret: clearSecret,
        }),
      );
      setSecret('');
      setClearSecret(false);
      setModels([]);
      notify({ severity: 'success', message: 'Налаштування державного шлюзу ШІ збережено.' });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    setBusy(true);
    try {
      setModels(await listAiGovUaModels());
      notify({ severity: 'success', message: 'Авторизація успішна. Список моделей отримано.' });
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PowerButton variant="outlined" onClick={() => void load()}>
        Державний шлюз ШІ: авторизація Azure
      </PowerButton>
      <Dialog open={open} onClose={close} fullWidth maxWidth="sm">
        <DialogTitle>Державний шлюз ШІ</DialogTitle>
        <DialogContent>
          {busy ? <CircularProgress size={24} /> : null}
          {settings ? (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Typography variant="body2">
                Спільна авторизація для движків з Base URL https://inference.ai.mod.gov.ua/v1.
                Токени оновлюються автоматично. Звичайний токен у цих движках залиште порожнім.
              </Typography>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={settings.enabled}
                    disabled={busy || clearSecret}
                    onChange={(_, enabled) => setSettings({ ...settings, enabled })}
                  />
                }
                label="Увімкнути державний шлюз"
              />
              <TextField
                label="Tenant ID"
                value={settings.tenantId}
                disabled={busy}
                onChange={(event) => setSettings({ ...settings, tenantId: event.target.value })}
              />
              <TextField
                label="Client ID"
                value={settings.clientId}
                disabled={busy}
                onChange={(event) => setSettings({ ...settings, clientId: event.target.value })}
              />
              <TextField
                label="Scope API"
                value={settings.scope}
                disabled={busy}
                helperText="Scope, наданий провайдером, із суфіксом /.default."
                onChange={(event) => setSettings({ ...settings, scope: event.target.value })}
              />
              <TextField
                label="Секрет застосунку"
                type="password"
                autoComplete="new-password"
                value={secret}
                disabled={busy || clearSecret}
                helperText={
                  settings.hasClientSecret
                    ? 'Секрет збережено. Порожнє поле залишає його без змін.'
                    : 'Секрет ще не задано.'
                }
                onChange={(event) => setSecret(event.target.value)}
              />
              {settings.hasClientSecret ? (
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={clearSecret}
                      disabled={busy || settings.enabled}
                      onChange={(_, clear) => {
                        setClearSecret(clear);
                        setSecret('');
                      }}
                    />
                  }
                  label="Видалити збережений секрет (шлюз має бути вимкнений)"
                />
              ) : null}
              {models.length ? (
                <Typography variant="body2">Доступні моделі: {models.join(', ')}</Typography>
              ) : null}
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <PowerButton disabled={busy} onClick={close}>
            Закрити
          </PowerButton>
          <PowerButton disabled={busy || !settings?.enabled} onClick={() => void check()}>
            Перевірити збережені налаштування
          </PowerButton>
          <PowerButton variant="contained" disabled={busy || !settings} onClick={() => void save()}>
            Зберегти
          </PowerButton>
        </DialogActions>
      </Dialog>
    </>
  );
}
