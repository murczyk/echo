import React from 'react';
import { Box, TextField, Autocomplete, Stack, Typography, Chip } from '@mui/material';
import { useFormContext, Controller } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import { normalizeMultiValue, type MessageFormData } from '../create-message-drawer.schema';

type Props = {
  isEditMode: boolean;
  busy: boolean;
  recentValues: any;
  getProposedCallsigns: (current: string[]) => string[];
  addSuggestedCallsign: (callsign: string) => void;
  networkNameOptions: string[];
  networkNameLoading: boolean;
  setNetworkNameInput: (val: string) => void;
  signalNameOptions: string[];
  signalNameLoading: boolean;
  setSignalNameInput: (val: string) => void;
  callsignOptions: string[];
  callsignLoading: boolean;
  setCallsignInput: (val: string) => void;
  freqOptions: string[];
  freqLoading: boolean;
  setFreqInput: (val: string) => void;
};

export function NetworkSection({
  isEditMode,
  busy,
  recentValues,
  getProposedCallsigns,
  addSuggestedCallsign,
  networkNameOptions,
  networkNameLoading,
  setNetworkNameInput,
  signalNameOptions,
  signalNameLoading,
  setSignalNameInput,
  callsignOptions,
  callsignLoading,
  setCallsignInput,
  freqOptions,
  freqLoading,
  setFreqInput,
}: Props) {
  const {
    control,
    trigger,
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

        {!isEditMode && (
          <Controller
            name="network_name"
            control={control}
            render={({ field }) => (
              <Autocomplete
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
                  }
                }}
                onChange={(_, newValue) => {
                  field.onChange(newValue || '');
                }}
                renderInput={(params) => (
                  <TextField {...params} label="Мережа" size="small" fullWidth disabled={busy} />
                )}
              />
            )}
          />
        )}
      </Box>

      <Controller
        name="callsigns"
        control={control}
        render={({ field }) => (
          <Stack spacing={1}>
            <Autocomplete
              multiple
              freeSolo
              autoSelect
              noOptionsText="Немає варіантів"
              options={Array.from(
                new Set([...(recentValues?.callsigns || []), ...callsignOptions]),
              )}
              value={field.value || []}
              loading={callsignLoading}
              onInputChange={(_, newValue, reason) => {
                if (reason === 'input') {
                  setCallsignInput(newValue);
                }
              }}
              onChange={(_, newValue) => field.onChange(normalizeMultiValue(newValue as string[]))}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Позивні"
                  size="small"
                  placeholder="Розділяйте комою або Enter"
                />
              )}
              disabled={busy}
            />
            {isEditMode &&
              (() => {
                const proposed = getProposedCallsigns(field.value ?? []);
                return proposed.length > 0 ? (
                  <Stack spacing={0.75}>
                    <Typography variant="caption" color="text.secondary">
                      Запропоновані позивні
                    </Typography>
                    <Stack direction="row" gap={1} flexWrap="wrap">
                      {proposed.map((callsign) => (
                        <Chip
                          key={callsign}
                          label={callsign}
                          onClick={busy ? undefined : () => addSuggestedCallsign(callsign)}
                          variant="filled"
                        />
                      ))}
                    </Stack>
                  </Stack>
                ) : null;
              })()}
          </Stack>
        )}
      />
    </FormSectionWrapper>
  );
}
