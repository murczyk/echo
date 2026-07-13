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
  const { control, watch } = useFormContext<MessageFormData>();

  const networkSignalName = watch('network_signal_name');
  const dmrSenderId = watch('dmr_sender_id');
  const dmrSenderName = watch('dmr_sender_name');
  const dmrCallGroupId = watch('dmr_call_group_id');
  const dmrCallGroupName = watch('dmr_call_group_name');
  const dmrHashId = watch('dmr_hash_id');

  const isDmr = !!(
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
    <FormSectionWrapper title="DMR (Digital Mobile Radio)">
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 2,
        }}
      >
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
                  label="ID відправника (DMR)"
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
                  label="Ім'я відправника (DMR)"
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
                  label="ID групи виклику (DMR)"
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
                  label="Ім'я групи виклику (DMR)"
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
                <TextField
                  {...params}
                  label="Hash ID (DMR)"
                  size="small"
                  fullWidth
                  disabled={busy}
                />
              )}
            />
          )}
        />
      </Box>
    </FormSectionWrapper>
  );
}
