import React from 'react';
import { Box, TextField, Autocomplete } from '@mui/material';
import { useFormContext, Controller } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import { type MessageFormData } from '../manage-message-drawer.schema';

type Props = {
  isEditMode: boolean;
  busy: boolean;
  recentValues: any;
  networkNameOptions: string[];
  networkNameLoading: boolean;
  setNetworkNameInput: (val: string) => void;
  freqOptions: string[];
  freqLoading: boolean;
  setFreqInput: (val: string) => void;
};

export function NetworkSection({
  isEditMode,
  busy,
  recentValues,
  networkNameOptions,
  networkNameLoading,
  setNetworkNameInput,
  freqOptions,
  freqLoading,
  setFreqInput,
}: Props) {
  const {
    control,
    trigger,
    setValue,
    formState: { errors },
  } = useFormContext<MessageFormData>();

  return (
    <FormSectionWrapper title="Мережа та радіо">
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 2,
        }}
      >
        <Controller
          name="freq"
          control={control}
          render={({ field }) => (
            <Autocomplete
              freeSolo
              forcePopupIcon
              noOptionsText="Немає варіантів"
              options={Array.from(new Set([...(recentValues?.freq || []), ...freqOptions]))}
              value={field.value ?? ''}
              loading={freqLoading}
              disabled={busy}
              onInputChange={(_, newValue, reason) => {
                if (reason === 'input') {
                  setFreqInput(newValue);
                  field.onChange(newValue);
                }
              }}
              onChange={(_, newValue) => field.onChange(newValue || '')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Частота (МГц)"
                  placeholder="напр. 149.5000"
                  size="small"
                  fullWidth
                  error={!!errors.freq}
                  helperText={errors.freq?.message}
                  disabled={busy}
                />
              )}
            />
          )}
        />

        <Controller
          name="network_name"
          control={control}
          render={({ field }) => (
            <Autocomplete
              freeSolo
              forcePopupIcon
              noOptionsText="Немає варіантів"
              options={Array.from(
                new Set([...(recentValues?.network_name || []), ...networkNameOptions]),
              )}
              value={field.value ?? ''}
              loading={networkNameLoading}
              disabled={busy}
              onInputChange={(_, newValue, reason) => {
                if (reason === 'input') {
                  setNetworkNameInput(newValue);
                  field.onChange(newValue);
                  if (newValue) {
                    setValue('network_signal_name', 'DMR', { shouldValidate: true });
                  }
                }
              }}
              onChange={(_, newValue) => {
                field.onChange(newValue || '');
                if (newValue) {
                  setValue('network_signal_name', 'DMR', { shouldValidate: true });
                }
              }}
              renderInput={(params) => (
                <TextField {...params} label="Мережа" size="small" fullWidth disabled={busy} />
              )}
            />
          )}
        />
      </Box>
    </FormSectionWrapper>
  );
}
