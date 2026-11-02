import {
  Card,
  CardContent,
  CircularProgress,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerForm } from '../../components/PowerForm';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { updateDeviceSettings } from '../../services/api/devices';
import { formatDeviceErrorMessage } from '../devices/helpers';

export function DeviceActivitySettingsPanel() {
  const [enabled, setEnabled] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();
  const notifyRef = useRef(notify);

  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoaded(false);
    setError(null);
    void updateDeviceSettings({}, { signal: controller.signal })
      .then((settings) => {
        if (controller.signal.aborted) return;
        setEnabled(settings.activitySplitFilesAudio);
        setSaved(settings.activitySplitFilesAudio);
        setLoaded(true);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        const message = `Не вдалося завантажити налаштування активності: ${formatDeviceErrorMessage(error)}`;
        setError(message);
        notifyRef.current({ severity: 'error', message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [loadAttempt]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!loaded || saving || enabled === saved) return;
    setSaving(true);
    setError(null);
    try {
      const settings = await updateDeviceSettings({ activitySplitFilesAudio: enabled });
      setEnabled(settings.activitySplitFilesAudio);
      setSaved(settings.activitySplitFilesAudio);
      notify({ severity: 'success', message: 'Відображення активності пристроїв збережено.' });
    } catch (error) {
      const message = `Не вдалося зберегти налаштування активності: ${formatDeviceErrorMessage(error)}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card variant="outlined">
      <CardContent>
        <PowerForm
          onSubmit={(event) => void save(event)}
          canSubmit={loaded && !saving && enabled !== saved}
        >
          <Stack spacing={2}>
            <Typography component="h2" variant="h6">
              Активність у списку пристроїв
            </Typography>
            <Typography color="text.secondary" variant="body2">
              За замовчуванням стовпці розбито за типами файлів. Увімкніть, щоб показувати два
              кольори: усі завантаження розділу «Файли» та завантаження окремого розділу «Аудіо».
            </Typography>
            {loading ? (
              <CircularProgress size={24} aria-label="Завантаження налаштувань активності" />
            ) : null}
            {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
            {!loading && !loaded && error ? (
              <PowerButton
                type="button"
                variant="outlined"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                Повторити
              </PowerButton>
            ) : null}
            <FormControlLabel
              control={
                <Switch
                  checked={enabled}
                  disabled={!loaded || saving}
                  onChange={(_, checked) => setEnabled(checked)}
                />
              }
              label="Розбивка «Файли / Аудіо»"
            />
            <div>
              <PowerButton
                type="submit"
                variant="contained"
                disabled={!loaded || saving || enabled === saved}
              >
                Зберегти відображення
              </PowerButton>
            </div>
          </Stack>
        </PowerForm>
      </CardContent>
    </Card>
  );
}
