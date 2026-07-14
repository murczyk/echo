import React from 'react';
import { Box, TextField, Autocomplete } from '@mui/material';
import { useFormContext, Controller } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import type { MessageFormData } from '../create-message-drawer.schema';

type Props = {
  isEditMode: boolean;
  showAdvanced: boolean;
  busy: boolean;
  recentValues: any;
};

export function DmrSection({ isEditMode, showAdvanced, busy, recentValues }: Props) {
  const {
    control,
    watch,
    trigger,
    formState: { errors },
  } = useFormContext<MessageFormData>();

  const networkCc = watch('network_cc');

  const networkSignalName = watch('network_signal_name');
  const dmrSenderId = watch('dmr_sender_id');
  const dmrSenderName = watch('dmr_sender_name');
  const dmrCallGroupId = watch('dmr_call_group_id');
  const dmrCallGroupName = watch('dmr_call_group_name');
  const dmrHashId = watch('dmr_hash_id');

  const isDmr = !!(
    (networkCc !== null && networkCc !== undefined && String(networkCc).trim() !== '') ||
    networkSignalName?.trim().toLowerCase() === 'dmr' ||
    dmrSenderId?.trim() ||
    dmrSenderName?.trim() ||
    dmrCallGroupId?.trim() ||
    dmrCallGroupName?.trim() ||
    dmrHashId?.trim()
  );

  if (!isDmr && !showAdvanced) {
    return null;
  }

  return (
    <FormSectionWrapper title="DMR">
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 2,
        }}
      >
        {!isEditMode && (
          <Controller
            name="network_cc"
            control={control}
            render={({ field }) => (
              <Autocomplete
                freeSolo
                forcePopupIcon
                noOptionsText="Немає варіантів"
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
        <Controller
          name="dmr_sender_id"
          control={control}
          render={({ field }) => (
            <Autocomplete
              freeSolo
              forcePopupIcon
              options={recentValues?.dmr_sender_id || []}
              value={field.value ?? ''}
              disabled={busy}
              onInputChange={(_, newValue, reason) => {
                if (reason === 'input') field.onChange(newValue);
              }}
              onChange={(_, newValue) => field.onChange(newValue || '')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="ID відправника"
                  size="small"
                  fullWidth
                  disabled={busy}
                />
              )}
            />
          )}
        />
        <Controller
          name="dmr_sender_name"
          control={control}
          render={({ field }) => (
            <Autocomplete
              freeSolo
              forcePopupIcon
              options={recentValues?.dmr_sender_name || []}
              value={field.value ?? ''}
              disabled={busy}
              onInputChange={(_, newValue, reason) => {
                if (reason === 'input') field.onChange(newValue);
              }}
              onChange={(_, newValue) => field.onChange(newValue || '')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Ім'я відправника"
                  size="small"
                  fullWidth
                  disabled={busy}
                />
              )}
            />
          )}
        />
        <Controller
          name="dmr_call_group_id"
          control={control}
          render={({ field }) => (
            <Autocomplete
              freeSolo
              forcePopupIcon
              options={recentValues?.dmr_call_group_id || []}
              value={field.value ?? ''}
              disabled={busy}
              onInputChange={(_, newValue, reason) => {
                if (reason === 'input') field.onChange(newValue);
              }}
              onChange={(_, newValue) => field.onChange(newValue || '')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="ID групи виклику"
                  size="small"
                  fullWidth
                  disabled={busy}
                />
              )}
            />
          )}
        />
        <Controller
          name="dmr_call_group_name"
          control={control}
          render={({ field }) => (
            <Autocomplete
              freeSolo
              forcePopupIcon
              options={recentValues?.dmr_call_group_name || []}
              value={field.value ?? ''}
              disabled={busy}
              onInputChange={(_, newValue, reason) => {
                if (reason === 'input') field.onChange(newValue);
              }}
              onChange={(_, newValue) => field.onChange(newValue || '')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Ім'я групи виклику"
                  size="small"
                  fullWidth
                  disabled={busy}
                />
              )}
            />
          )}
        />
        <Controller
          name="dmr_hash_id"
          control={control}
          render={({ field }) => (
            <Autocomplete
              freeSolo
              forcePopupIcon
              options={recentValues?.dmr_hash_id || []}
              value={field.value ?? ''}
              disabled={busy}
              onInputChange={(_, newValue, reason) => {
                if (reason === 'input') field.onChange(newValue);
              }}
              onChange={(_, newValue) => field.onChange(newValue || '')}
              renderInput={(params) => (
                <TextField {...params} label="Hash ID" size="small" fullWidth disabled={busy} />
              )}
            />
          )}
        />
      </Box>
    </FormSectionWrapper>
  );
}
