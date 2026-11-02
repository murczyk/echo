import { Autocomplete, TextField } from '@mui/material';
import { useEffect, useState } from 'react';

import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { isAbortError } from '../../../services/api/client';
import { listDeviceTags } from '../../../services/api/devices';
import { formatDeviceErrorMessage } from '../helpers';
import {
  DEVICE_DESCRIPTION_MAX_CHARS,
  type DeviceFieldPermissions,
  type DeviceServerFieldErrors,
  type DeviceUpsertForm,
} from '../device-form';

export function DeviceMetadataFields({
  form,
  permissions,
  disabled,
  errors,
  onChange,
}: {
  form: DeviceUpsertForm;
  permissions: DeviceFieldPermissions;
  disabled: boolean;
  errors: DeviceServerFieldErrors;
  onChange: (patch: Partial<DeviceUpsertForm>) => void;
}) {
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!permissions.analyticalData) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void listDeviceTags({ signal: controller.signal })
      .then((tags) => {
        if (!controller.signal.aborted) setOptions(tags);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && !isAbortError(reason)) {
          setError(`Помилка завантаження тегів: ${formatDeviceErrorMessage(reason)}`);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [permissions.analyticalData, retry]);

  return (
    <>
      {permissions.sourceData ? (
        <TextField
          label="Опис пристрою"
          multiline
          minRows={3}
          fullWidth
          size="small"
          disabled={disabled}
          value={form.description}
          onChange={(event) => onChange({ description: event.target.value })}
          inputProps={{ maxLength: DEVICE_DESCRIPTION_MAX_CHARS }}
          error={Boolean(errors.description)}
          helperText={errors.description}
        />
      ) : null}
      {permissions.analyticalData ? (
        <>
          {error ? (
            <PowerAlert
              severity="error"
              action={
                <PowerButton disabled={disabled} onClick={() => setRetry((value) => value + 1)}>
                  Повторити
                </PowerButton>
              }
            >
              {error}
            </PowerAlert>
          ) : null}
          <Autocomplete<string, true, false, true>
            multiple
            freeSolo
            filterSelectedOptions
            options={options}
            value={form.tags}
            loading={loading}
            disabled={disabled}
            onChange={(_event, tags) => {
              const seen = new Set<string>();
              onChange({
                tags: tags
                  .map((tag) => tag.trim())
                  .filter((tag) => {
                    const key = tag.toLocaleLowerCase();
                    if (!key || seen.has(key)) return false;
                    seen.add(key);
                    return true;
                  }),
              });
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Теги"
                size="small"
                error={Boolean(errors.tags)}
                helperText={
                  errors.tags ??
                  'Оберіть тег або введіть назву й натисніть Enter, щоб створити новий.'
                }
              />
            )}
          />
        </>
      ) : null}
    </>
  );
}
