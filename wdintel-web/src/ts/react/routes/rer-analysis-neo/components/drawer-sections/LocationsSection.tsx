import React from 'react';
import { TextField, Autocomplete } from '@mui/material';
import { useFormContext, Controller } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import { normalizeMultiValue, type MessageFormData } from '../create-message-drawer.schema';

type Props = {
  busy: boolean;
  recentValues: any;
};

export function LocationsSection({ busy, recentValues }: Props) {
  const {
    control,
    formState: { errors },
  } = useFormContext<MessageFormData>();

  return (
    <FormSectionWrapper title="Локації та координати">
      <Controller
        name="locations"
        control={control}
        render={({ field }) => (
          <Autocomplete
            multiple
            freeSolo
            autoSelect
            options={recentValues?.locations || []}
            value={field.value || []}
            onChange={(_, newValue) => field.onChange(normalizeMultiValue(newValue as string[]))}
            renderInput={(params) => <TextField {...params} label="Назви локацій" size="small" />}
            disabled={busy}
          />
        )}
      />

      <Controller
        name="coords"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            label="Координати (lat, lon або MGRS)"
            fullWidth
            error={!!errors.coords}
            helperText={errors.coords?.message ?? null}
            disabled={busy}
            placeholder="49.12345, 37.12345"
          />
        )}
      />
    </FormSectionWrapper>
  );
}
