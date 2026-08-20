import { Card, CardContent, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useState, type FormEvent } from 'react';

import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerForm } from '../../components/PowerForm';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { updateDeviceSettings } from '../../services/api/devices';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function DeviceGeneralSettingsPanel() {
  const [hasMattermostWebhook, setHasMattermostWebhook] = useState(false);
  const [mattermostWebhookUrl, setMattermostWebhookUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    void updateDeviceSettings({}, { signal: controller.signal })
      .then((settings) => {
        if (!controller.signal.aborted) {
          setHasMattermostWebhook(settings.hasMattermostWebhook);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(`Не вдалося завантажити налаштування: ${errorMessage(error)}`);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [loadAttempt]);

  const saveWebhook = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const webhook = mattermostWebhookUrl.trim();
    if (!webhook || saving) return;

    setSaving(true);
    setSaveError(null);
    try {
      const settings = await updateDeviceSettings({ mattermostWebhookUrl: webhook });
      setHasMattermostWebhook(settings.hasMattermostWebhook);
      setMattermostWebhookUrl('');
      notify({
        severity: 'success',
        message: 'Mattermost webhook для пристроїв збережено.',
      });
    } catch (error) {
      setSaveError(`Не вдалося зберегти webhook: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const clearWebhook = async () => {
    if (!hasMattermostWebhook || saving) return;

    setSaving(true);
    setSaveError(null);
    try {
      const settings = await updateDeviceSettings({ clearMattermostWebhook: true });
      setHasMattermostWebhook(settings.hasMattermostWebhook);
      setMattermostWebhookUrl('');
      notify({
        severity: 'success',
        message: 'Mattermost webhook для пристроїв видалено.',
      });
    } catch (error) {
      setSaveError(`Не вдалося видалити webhook: ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <PowerForm
          onSubmit={(event) => void saveWebhook(event)}
          canSubmit={!loading && !saving && mattermostWebhookUrl.trim().length > 0}
        >
          <Stack spacing={2}>
            <div>
              <Typography component="h2" variant="h6">
                Mattermost нотифікації
              </Typography>
              <Typography color="text.secondary" variant="body2">
                Echo надсилатиме сповіщення про створення пристроїв і завершення їх аналізу.
              </Typography>
            </div>

            {loading ? (
              <CircularProgress size={24} aria-label="Завантаження налаштувань Mattermost" />
            ) : null}
            {loadError ? (
              <Stack spacing={1} alignItems="flex-start">
                <PowerAlert severity="error">{loadError}</PowerAlert>
                <PowerButton
                  type="button"
                  variant="outlined"
                  onClick={() => setLoadAttempt((attempt) => attempt + 1)}
                >
                  Повторити
                </PowerButton>
              </Stack>
            ) : null}
            {saveError ? <PowerAlert severity="error">{saveError}</PowerAlert> : null}

            {!loading && !loadError ? (
              <>
                <Typography role="status" variant="body2">
                  {hasMattermostWebhook
                    ? 'Webhook налаштовано. Поточний URL приховано.'
                    : 'Webhook ще не налаштовано.'}
                </Typography>
                <TextField
                  fullWidth
                  label="Mattermost webhook URL"
                  type="password"
                  autoComplete="new-password"
                  value={mattermostWebhookUrl}
                  onChange={(event) => setMattermostWebhookUrl(event.target.value)}
                  onBlur={(event) => setMattermostWebhookUrl(event.target.value.trim())}
                  disabled={saving}
                  helperText={
                    hasMattermostWebhook
                      ? 'Введіть новий URL, щоб замінити налаштований webhook. Порожнє поле зберігає поточний URL.'
                      : 'Вставте URL вхідного webhook Mattermost.'
                  }
                />
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="flex-start">
                  <PowerButton
                    type="submit"
                    variant="contained"
                    disabled={saving || mattermostWebhookUrl.trim().length === 0}
                  >
                    Зберегти webhook
                  </PowerButton>
                  <PowerButton
                    type="button"
                    variant="outlined"
                    color="error"
                    disabled={saving || !hasMattermostWebhook}
                    onClick={() => void clearWebhook()}
                  >
                    Видалити webhook
                  </PowerButton>
                </Stack>
              </>
            ) : null}
          </Stack>
        </PowerForm>
      </CardContent>
    </Card>
  );
}
