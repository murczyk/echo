import { FormControlLabel, Switch } from '@mui/material';
import { useEffect, useState } from 'react';
import { PowerAlert } from '../../components/PowerAlert';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import {
  getMessengerAlertPreference,
  saveMessengerAlertPreference,
} from '../../services/api/messenger-alerts';

export function SettingsMessengerAlerts() {
  const { notify } = usePowerSnackbar();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void getMessengerAlertPreference(controller.signal)
      .then((preference) => {
        if (controller.signal.aborted) return;
        setEnabled(preference.receiveAlertsInMessenger ?? false);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = `Помилка завантаження сповіщень: ${error instanceof Error ? error.message : 'невідома помилка'}`;
        setError(message);
        notify({ severity: 'error', message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [notify]);

  async function save(value: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const preference = await saveMessengerAlertPreference({ receiveAlertsInMessenger: value });
      setEnabled(preference.receiveAlertsInMessenger ?? false);
      notify({ severity: 'success', message: 'Налаштування сповіщень збережено' });
    } catch (error) {
      const message = `Помилка збереження сповіщень: ${error instanceof Error ? error.message : 'невідома помилка'}`;
      setError(message);
      notify({ severity: 'error', message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-echo-sm">
      {error ? (
        <PowerAlert severity="error" autoHideDuration={null}>
          {error}
        </PowerAlert>
      ) : null}
      <FormControlLabel
        label="Отримувати сповіщення в месенджері"
        control={
          <Switch
            checked={enabled}
            disabled={busy || !loaded}
            onChange={(_, value) => void save(value)}
          />
        }
      />
      <p className="m-0 text-echo-sm">
        Для доставки адміністратор має прив’язати профіль в месенджері до вашого логіна.
      </p>
    </div>
  );
}
