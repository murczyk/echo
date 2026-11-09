import { Autocomplete, FormControlLabel, Switch, TextField } from '@mui/material';
import { useEffect, useState } from 'react';
import type { GroupSendingSettings, Organism } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { getGroupSendingSettings } from '../../services/api/group-sending';

export function useGroupSendingSettings(masterKey: string | null) {
  const { notify } = usePowerSnackbar();
  const [loaded, setLoaded] = useState<{
    masterKey: string;
    settings: GroupSendingSettings;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setLoaded(null);
    setError(null);
    if (!masterKey) return;
    const controller = new AbortController();
    void getGroupSendingSettings(masterKey, { signal: controller.signal })
      .then((settings) => {
        if (!controller.signal.aborted) setLoaded({ masterKey, settings });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = `Не вдалося завантажити налаштування надсилання: ${
          error instanceof Error ? error.message : String(error)
        }`;
        setError(message);
        notify({ severity: 'error', message });
      });
    return () => controller.abort();
  }, [masterKey, attempt, notify]);

  const settings = loaded?.masterKey === masterKey ? loaded.settings : null;
  return {
    settings,
    error,
    isReady: Boolean(settings),
    retry: () => setAttempt((attempt) => attempt + 1),
    onChange: (settings: GroupSendingSettings) => {
      if (masterKey) setLoaded({ masterKey, settings });
    },
    request: {
      sendMessages: settings?.canSendMessages ? settings.sendMessages : null,
      senderOrganismIds: settings?.canSendMessages ? settings.senderOrganismIds : null,
    },
  };
}

export function GroupSendingFields({
  settings,
  error,
  retry,
  onChange,
  organisms,
  disabled,
}: ReturnType<typeof useGroupSendingSettings> & {
  organisms: Organism[];
  disabled: boolean;
}) {
  if (error) {
    return (
      <PowerAlert severity="error">
        {error}
        <PowerButton onClick={retry}>Повторити</PowerButton>
      </PowerAlert>
    );
  }
  if (!settings) {
    return <p role="status">Завантаження налаштувань надсилання…</p>;
  }
  if (!settings.canSendMessages) return null;
  const selected = settings.senderOrganismIds.map(
    (id) => organisms.find((organism) => organism.id === id) ?? { id, name: `#${id}` },
  );
  return (
    <>
      <FormControlLabel
        label="Надсилати повідомлення"
        control={
          <Switch
            checked={settings.sendMessages}
            disabled={disabled}
            onChange={(_, sendMessages) => onChange({ ...settings, sendMessages })}
          />
        }
      />
      {settings.sendMessages ? (
        <Autocomplete
          multiple
          disabled={disabled}
          options={organisms.filter(
            (organism) => organism.enabled || settings.senderOrganismIds.includes(organism.id),
          )}
          value={selected}
          getOptionLabel={(organism) => organism.name}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          onChange={(_, selected) =>
            onChange({ ...settings, senderOrganismIds: selected.map((organism) => organism.id) })
          }
          renderInput={(params) => (
            <TextField
              {...params}
              label="Організми, яким дозволено надсилати"
              helperText="Повідомлення інших організмів зберігаються лише в Echo. Порожній список забороняє надсилання всім."
            />
          )}
        />
      ) : null}
    </>
  );
}
