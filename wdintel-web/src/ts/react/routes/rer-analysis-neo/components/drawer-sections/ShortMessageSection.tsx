import React from 'react';
import { TextField } from '@mui/material';
import { useFormContext, Controller } from 'react-hook-form';
import type { MessageFormData } from '../manage-message-drawer.schema';

type Props = {
  showAdvanced: boolean;
  busy: boolean;
};

export function ShortMessageSection({ showAdvanced, busy }: Props) {
  const {
    control,
    formState: { errors },
  } = useFormContext<MessageFormData>();

  if (!showAdvanced) {
    return null;
  }

  return (
    <Controller
      name="text"
      control={control}
      render={({ field }) => (
        <TextField
          {...field}
          label="Коротке повідомлення"
          fullWidth
          multiline
          rows={4}
          error={!!errors.text}
          helperText={errors.text?.message}
          disabled={busy}
        />
      )}
    />
  );
}
