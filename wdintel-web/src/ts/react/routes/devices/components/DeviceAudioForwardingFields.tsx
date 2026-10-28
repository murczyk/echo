import {
  Autocomplete,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import type {
  DeviceAudioForwardingChange,
  DeviceAudioForwardingGroup,
  DeviceAudioForwardingSettings,
} from '../../../../../Bindings';
import { AUTH_UNAUTHORIZED_EVENT } from '../../../auth-redirect';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { HttpRequestError, isAbortError } from '../../../services/api/client';
import { getDeviceAudioForwarding } from '../../../services/api/devices';
import { formatDeviceErrorMessage } from '../helpers';

type Props = {
  deviceId: string;
  disabled: boolean;
  value: DeviceAudioForwardingChange | undefined;
  onChange: (value: DeviceAudioForwardingChange | undefined) => void;
};

export function DeviceAudioForwardingFields({ deviceId, disabled, value, onChange }: Props) {
  const [settings, setSettings] = useState<DeviceAudioForwardingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void getDeviceAudioForwarding(deviceId, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setSettings(result);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        const message = `Не вдалося завантажити налаштування пересилання: ${formatDeviceErrorMessage(error)}`;
        setError(message);
        notifyRef.current({ severity: 'error', message });
        if (error instanceof HttpRequestError && error.status === 401) {
          window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
        }
      });
    return () => controller.abort();
  }, [deviceId, attempt]);

  const enabled = value?.enabled ?? settings?.enabled ?? false;
  const selected =
    settings?.groups.filter((group) =>
      value
        ? (group.selected && !value.removeGroups.includes(group.masterKey)) ||
          value.addGroups.includes(group.masterKey)
        : group.selected,
    ) ?? [];
  const change = (enabled: boolean, selected: DeviceAudioForwardingGroup[]) => {
    if (!settings) return;
    const keys = new Set(selected.map((group) => group.masterKey));
    const addGroups = settings.groups
      .filter((group) => !group.selected && keys.has(group.masterKey))
      .map((group) => group.masterKey);
    const removeGroups = settings.groups
      .filter((group) => group.selected && !keys.has(group.masterKey))
      .map((group) => group.masterKey);
    onChange(
      enabled === settings.enabled && addGroups.length === 0 && removeGroups.length === 0
        ? undefined
        : { version: settings.version, enabled, addGroups, removeGroups },
    );
  };
  return (
    <Stack spacing={1.5}>
      <Divider />
      <Typography variant="subtitle1">Автоматичне пересилання аудіо</Typography>
      {error ? (
        <PowerAlert
          severity="error"
          action={
            <PowerButton onClick={() => setAttempt((current) => current + 1)}>
              Повторити
            </PowerButton>
          }
        >
          {error}
        </PowerAlert>
      ) : null}
      {!settings && !error ? (
        <Typography color="text.secondary">Завантаження налаштувань…</Typography>
      ) : null}
      {settings ? (
        <>
          <FormControlLabel
            label="Пересилати нові аудіо в групи"
            control={
              <Switch
                checked={enabled}
                disabled={disabled}
                onChange={(_event, checked) => change(checked, selected)}
              />
            }
          />
          <Autocomplete<DeviceAudioForwardingGroup, true>
            multiple
            disableCloseOnSelect
            filterSelectedOptions
            options={settings.groups}
            value={selected}
            disabled={disabled}
            size="small"
            getOptionLabel={(group) => group.name}
            isOptionEqualToValue={(left, right) => left.masterKey === right.masterKey}
            onChange={(_event, groups) => change(enabled, groups)}
            noOptionsText="Немає доступних груп Echo Native"
            renderInput={(params) => <TextField {...params} label="Групи для пересилання" />}
          />
          <Typography variant="caption" color="text.secondary">
            Показано лише доступні вам групи. Перемикач діє на всі групи пристрою. Зміни
            застосовуються до нових аудіо; прийняті раніше завершать доставку.
          </Typography>
        </>
      ) : null}
    </Stack>
  );
}
