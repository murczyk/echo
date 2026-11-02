import { useEffect, useState } from 'react';
import type { MessageCreationSettings } from '../../../../../Bindings';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { getMessageCreationSettings } from '../../../services/api/role-message-settings';
import { isAbortError } from '../../../services/api/client';

export function useMessageCreationSettings(active: boolean, userId?: string) {
  const [settings, setSettings] = useState<MessageCreationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { notify } = useOptionalPowerSnackbar();

  useEffect(() => {
    setSettings(null);
    setError(null);
    if (!active) return;
    const controller = new AbortController();
    getMessageCreationSettings(controller.signal)
      .then((settings) => {
        if (!controller.signal.aborted) setSettings(settings);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        const message = error instanceof Error ? error.message : 'Помилка завантаження правил.';
        setError(message);
        notify({
          message: `Не вдалося завантажити налаштування ролей: ${message}`,
          severity: 'error',
        });
      });
    return () => controller.abort();
  }, [active, userId, attempt]);

  return {
    settings: active ? settings : null,
    blocked: active && settings === null,
    error: active ? error : null,
    retry: () => setAttempt((previous) => previous + 1),
  };
}
