import { Autocomplete, TextField } from '@mui/material';
import { useEffect, useState } from 'react';
import { searchMessengerProfiles } from '../../services/api/logins';
import { usePowerSnackbar } from '../../components/PowerSnackbar';

type Option = { id: string; label: string };

export function MessengerProfileSelect({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  const { notify } = usePowerSnackbar();
  const [query, setQuery] = useState(value ?? '');
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      void searchMessengerProfiles({ query }, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setOptions(
            Object.entries(response.data).map(([id, profile]) => ({
              id,
              label: [profile?.givenName, profile?.familyName].filter(Boolean).join(' '),
            })),
          );
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          const message = `Помилка завантаження профілів: ${error instanceof Error ? error.message : 'невідома помилка'}`;
          setError(message);
          notify({ severity: 'error', message });
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, notify]);

  return (
    <Autocomplete
      fullWidth
      disabled={disabled}
      loading={loading}
      options={options}
      value={
        value ? (options.find((option) => option.id === value) ?? { id: value, label: '' }) : null
      }
      getOptionLabel={(option) => (option.label ? `${option.label} (${option.id})` : option.id)}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      filterOptions={(items) => items}
      onInputChange={(_, input, reason) => {
        if (reason === 'input' || reason === 'clear') setQuery(input);
      }}
      onChange={(_, option) => onChange(option?.id ?? null)}
      noOptionsText="Профілі не знайдено"
      loadingText="Завантаження…"
      renderInput={(params) => (
        <TextField
          {...params}
          label="Профіль в месенджері"
          error={Boolean(error)}
          helperText={error ?? 'Необов’язково. Пошук за початком імені або ID профілю.'}
        />
      )}
    />
  );
}
