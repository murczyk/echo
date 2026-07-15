import React from 'react';
import { Box, TextField, Autocomplete } from '@mui/material';
import { useFormContext, Controller } from 'react-hook-form';
import type { MessageFormData } from '../manage-message-drawer.schema';
import { FormSectionWrapper } from './FormSectionWrapper';

type Props = {
  showAdvanced: boolean;
  busy: boolean;
  recentValues: any;
  signalNameOptions: string[];
  signalNameLoading: boolean;
  setSignalNameInput: (val: string) => void;
};

export function AdvancedFieldsSection({
  showAdvanced,
  busy,
  recentValues,
  signalNameOptions,
  signalNameLoading,
  setSignalNameInput,
}: Props) {
  const {
    control,
    formState: { errors },
  } = useFormContext<MessageFormData>();

  if (!showAdvanced) {
    return null;
  }

  return (
    <FormSectionWrapper title="Розширені поля">
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Controller
          name="network_signal_name"
          control={control}
          render={({ field }) => (
            <Autocomplete
              freeSolo
              forcePopupIcon
              noOptionsText="Немає варіантів"
              options={Array.from(
                new Set([...(recentValues?.network_signal_name || []), ...signalNameOptions]),
              )}
              value={field.value ?? ''}
              loading={signalNameLoading}
              disabled={busy}
              onInputChange={(_, newValue, reason) => {
                if (reason === 'input') {
                  setSignalNameInput(newValue);
                  field.onChange(newValue);
                }
              }}
              onChange={(_, newValue) => {
                field.onChange(newValue || '');
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Назва сигнала мережі"
                  size="small"
                  fullWidth
                  error={!!errors.network_signal_name}
                  helperText={errors.network_signal_name?.message}
                  disabled={busy}
                />
              )}
            />
          )}
        />

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
      </Box>
    </FormSectionWrapper>
  );
}
