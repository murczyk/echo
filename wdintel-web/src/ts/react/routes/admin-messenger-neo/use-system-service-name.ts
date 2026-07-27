import { useEffect, useState } from 'react';

import { getSystemServiceNameAvailability } from '../../services/api/messenger';

const SYSTEM_SERVICE_NAME_AVAILABILITY_DEBOUNCE_MS = 250;

type UseSystemServiceNameParams = {
  active: boolean;
  displayName: string;
  messengerType: string;
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return 'Невідома помилка. Спробуйте ще раз.';
}

export function normalizeToSystemName(displayName: string): string {
  const lower = displayName.toLowerCase();
  const withHyphens = lower.replace(/[\s_]+/g, '-');

  const mapping: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'h',
    ґ: 'g',
    д: 'd',
    е: 'e',
    є: 'ye',
    ж: 'zh',
    з: 'z',
    и: 'y',
    і: 'i',
    ї: 'yi',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'kh',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'shch',
    ь: '',
    ю: 'yu',
    я: 'ya',
  };

  const mapped = Array.from(withHyphens)
    .map((char) => mapping[char] ?? char)
    .join('');

  const filtered = mapped.replace(/[^a-z0-9-]/gi, '');
  const collapsed = filtered.replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, '');

  if (collapsed.length < 4) {
    if (collapsed.length === 0) return 'account';
    return `${collapsed}-${(collapsed.length + 1) % 1000}`;
  }

  if (collapsed.length > 50) return collapsed.slice(0, 50);

  return collapsed;
}

function validateSystemServiceName(name: string): string | null {
  if (name.length < 4) return 'Назва systemd unit має бути мінімум 4 символи';
  if (name.length > 50) return 'Назва systemd unit має бути максимум 50 символів';
  if (!/^[a-z0-9-]+$/.test(name)) {
    return 'Дозволені лише малі латинські літери, цифри та дефіс';
  }
  return null;
}

export function getSystemServicePrefix(messengerType: string): string {
  return messengerType === 'whatsapp' ? 'echo-whatsapp-bot@' : 'echo-signal-bot@';
}

export function useSystemServiceName({
  active,
  displayName,
  messengerType,
}: UseSystemServiceNameParams) {
  const [systemServiceName, setSystemServiceName] = useState('');
  const [systemServiceNameError, setSystemServiceNameError] = useState('');
  const [isEdited, setIsEdited] = useState(false);

  useEffect(() => {
    if (!active || isEdited || !displayName.trim()) return;

    const abortController = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      const normalizedSystemServiceName = normalizeToSystemName(displayName);
      try {
        const availability = await getSystemServiceNameAvailability(
          {
            messenger: messengerType,
            systemServiceName: normalizedSystemServiceName,
          },
          abortController.signal,
        );
        setSystemServiceName(availability.systemServiceName);
        setSystemServiceNameError('');
      } catch (error) {
        if (abortController.signal.aborted) return;
        setSystemServiceNameError(`Помилка перевірки назви: ${formatErrorMessage(error)}`);
      }
    }, SYSTEM_SERVICE_NAME_AVAILABILITY_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [active, displayName, isEdited, messengerType]);

  function updateFromDisplayName(nextDisplayName: string) {
    if (!isEdited) {
      setSystemServiceName(normalizeToSystemName(nextDisplayName));
    }
  }

  function editSystemServiceName(nextSystemServiceName: string) {
    setIsEdited(true);
    setSystemServiceName(nextSystemServiceName);
    setSystemServiceNameError('');
  }

  function validateSystemServiceNameInput(): boolean {
    const error = validateSystemServiceName(systemServiceName);
    setSystemServiceNameError(error ?? '');
    return error === null;
  }

  async function checkSystemServiceNameAvailability(): Promise<boolean> {
    try {
      const availability = await getSystemServiceNameAvailability({
        messenger: messengerType,
        systemServiceName,
      });
      if (availability.exists) {
        setSystemServiceNameError(
          `Systemd unit «${getSystemServicePrefix(messengerType)}${systemServiceName}» вже існує`,
        );
        return false;
      }
      setSystemServiceNameError('');
      return true;
    } catch (error) {
      setSystemServiceNameError(`Помилка перевірки назви: ${formatErrorMessage(error)}`);
      return false;
    }
  }

  function clearSystemServiceNameError() {
    setSystemServiceNameError('');
  }

  function showSystemServiceNameError(error: string) {
    setSystemServiceNameError(error);
  }

  function resetSystemServiceName() {
    setSystemServiceName('');
    setSystemServiceNameError('');
    setIsEdited(false);
  }

  return {
    systemServiceName,
    systemServiceNameError,
    checkSystemServiceNameAvailability,
    clearSystemServiceNameError,
    editSystemServiceName,
    resetSystemServiceName,
    showSystemServiceNameError,
    updateFromDisplayName,
    validateSystemServiceNameInput,
  };
}
