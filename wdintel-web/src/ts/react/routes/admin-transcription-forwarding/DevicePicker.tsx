import { Autocomplete, TextField } from '@mui/material';
import { useEffect, useState } from 'react';
import type { DeviceListItem } from '../../../../Bindings';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { isAbortError } from '../../services/api/client';
import { listDevices } from '../../services/api/devices';
import { formatDeviceErrorMessage } from '../devices/helpers';

type Props = {
  value: DeviceListItem | null;
  disabled: boolean;
  onChange: (device: DeviceListItem | null) => void;
};

export function DevicePicker({ value, disabled, onChange }: Props) {
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<DeviceListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { notify } = usePowerSnackbar();
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setOptions([]);
    setError(null);
    const timer = window.setTimeout(() => {
      void listDevices(
        {
          filterText: search,
          archivedFilter: 'active_only',
          aorIds: null,
          unitIds: null,
          createdBy: null,
          tags: null,
          limit: 50,
          offset: 0,
          sortBy: ['display_title_asc'],
        },
        { signal: controller.signal },
      )
        .then((response) => {
          if (!controller.signal.aborted) setOptions(response.list);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isAbortError(error)) return;
          const message = `Не вдалося завантажити пристрої: ${formatDeviceErrorMessage(error)}`;
          setError(message);
          notify({ severity: 'error', message });
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [search, notify]);
  return (
    <Autocomplete
      value={value}
      options={options}
      loading={loading}
      disabled={disabled}
      filterOptions={(items) => items}
      getOptionLabel={(device) => device.name || device.id}
      getOptionKey={(device) => device.id}
      isOptionEqualToValue={(left, right) => left.id === right.id}
      onChange={(_, device) => onChange(device)}
      onInputChange={(_, text, reason) => {
        if (reason === 'input' || reason === 'clear') setSearch(text);
      }}
      noOptionsText="Пристроїв не знайдено"
      loadingText="Завантаження…"
      renderInput={(params) => (
        <TextField
          {...params}
          label="Пристрій"
          error={Boolean(error)}
          helperText={error ?? 'Пошук за назвою пристрою'}
        />
      )}
    />
  );
}
