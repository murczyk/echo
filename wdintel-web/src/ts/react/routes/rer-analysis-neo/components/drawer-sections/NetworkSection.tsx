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
};

export function NetworkSection({
  isEditMode,
  busy,
  recentValues,
  getProposedCallsigns,
  addSuggestedCallsign,
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
              freeSolo
              forcePopupIcon
              options={recentValues?.freq || []}
              value={field.value ?? ''}
              disabled={busy}
              onInputChange={(_, newValue, reason) => {
                if (reason === 'input') field.onChange(newValue);
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
            name="network_cc"
            control={control}
            render={({ field }) => (
              <Autocomplete
                freeSolo
                forcePopupIcon
                options={recentValues?.network_cc || []}
                value={field.value ?? ''}
                disabled={busy}
                onInputChange={(_, newValue, reason) => {
                  if (reason === 'input') {
                    field.onChange(newValue);
                    void trigger('network_signal_name');
                  }
                }}
                onChange={(_, newValue) => {
                  field.onChange(newValue || '');
                  void trigger('network_signal_name');
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Колірний код (CC)"
                    placeholder="0–15"
                    size="small"
                    type="number"
                    fullWidth
                    error={!!errors.network_cc}
                    helperText={errors.network_cc?.message}
                    disabled={busy}
                  />
                )}
              />
            )}
          />
        )}
      </Box>

      {!isEditMode && (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
            gap: 2,
          }}
        >
          <Controller
            name="network_signal_name"
            control={control}
            render={({ field }) => (
              <Autocomplete
                freeSolo
                forcePopupIcon
                options={recentValues?.network_signal_name || []}
                value={field.value ?? ''}
                disabled={busy}
                onInputChange={(_, newValue, reason) => {
                  if (reason === 'input') field.onChange(newValue);
                }}
                onChange={(_, newValue) => field.onChange(newValue || '')}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Назва сигналу мережі"
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
            name="network_name"
            control={control}
            render={({ field }) => (
              <Autocomplete
                freeSolo
                forcePopupIcon
                options={recentValues?.network_name || []}
                value={field.value ?? ''}
                disabled={busy}
                onInputChange={(_, newValue, reason) => {
                  if (reason === 'input') {
                    field.onChange(newValue);
                    void trigger('network_signal_name');
                  }
                }}
                onChange={(_, newValue) => {
                  field.onChange(newValue || '');
                  void trigger('network_signal_name');
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Назва мережі"
                    size="small"
                    fullWidth
                    disabled={busy}
                  />
                )}
              />
            )}
          />
        </Box>
      )}

      <Controller
        name="callsigns"
        control={control}
        render={({ field }) => (
          <Stack spacing={1}>
            <Autocomplete
              multiple
              freeSolo
              autoSelect
              options={recentValues?.callsigns || []}
              value={field.value || []}
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
