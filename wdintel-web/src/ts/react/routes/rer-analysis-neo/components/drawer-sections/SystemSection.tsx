import React from 'react';
import { Box, TextField, Autocomplete, CircularProgress } from '@mui/material';
import { useFormContext, Controller } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import type { SignalGroupEntry } from '../../../../../../Bindings';
import type { MessageFormData } from '../create-message-drawer.schema';

type Props = {
  signalGroups: SignalGroupEntry[];
  groupsLoading: boolean;
  busy: boolean;
  isEditMode: boolean;
  cyberEchoEnabled: boolean;
  computerNameOptions: string[];
  computerNamesLoading: boolean;
  setComputerNameInput: (value: string) => void;
};

export function SystemSection({
  signalGroups,
  groupsLoading,
  busy,
  isEditMode,
  cyberEchoEnabled,
  computerNameOptions,
  computerNamesLoading,
  setComputerNameInput,
}: Props) {
  const {
    control,
    formState: { errors },
  } = useFormContext<MessageFormData>();

  return (
    <FormSectionWrapper title="Системні">
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 2,
        }}
      >
        <Controller
          name="signalGroupMasterKey"
          control={control}
          render={({ field }) => (
            <Autocomplete
              options={signalGroups}
              getOptionLabel={(option) => option.name || option.masterKey}
              isOptionEqualToValue={(option, value) => option.masterKey === value.masterKey}
              renderOption={(props, option) => {
                const { key, ...restProps } = props as any;
                return (
                  <li key={option.masterKey} {...restProps}>
                    {option.name || option.masterKey}
                  </li>
                );
              }}
              loading={groupsLoading}
              disabled={busy || isEditMode}
              value={signalGroups.find((g) => g.masterKey === field.value) || null}
              onChange={(_, newValue) => field.onChange(newValue?.masterKey || '')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Група"
                  size="small"
                  fullWidth
                  required
                  error={!!errors.signalGroupMasterKey}
                  helperText={errors.signalGroupMasterKey?.message}
                  disabled={busy || isEditMode || groupsLoading}
                  slotProps={{
                    input: {
                      ...params.InputProps,
                      endAdornment: (
                        <>
                          {groupsLoading ? <CircularProgress color="inherit" size={20} /> : null}
                          {params.InputProps.endAdornment}
                        </>
                      ),
                    },
                  }}
                />
              )}
            />
          )}
        />

        {cyberEchoEnabled && (
          <Controller
            name="computerName"
            control={control}
            render={({ field }) => (
              <Autocomplete
                freeSolo
                forcePopupIcon
                options={computerNameOptions}
                loading={computerNamesLoading}
                value={field.value ?? ''}
                disabled={busy || isEditMode}
                onInputChange={(_, newValue, reason) => {
                  if (reason !== 'input') return;
                  setComputerNameInput(newValue);
                  field.onChange(newValue);
                }}
                onChange={(_, newValue) => {
                  const resolved = newValue || '';
                  setComputerNameInput(resolved);
                  field.onChange(resolved);
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Назва комп'ютера"
                    size="small"
                    fullWidth
                    disabled={busy || isEditMode}
                  />
                )}
              />
            )}
          />
        )}
      </Box>
    </FormSectionWrapper>
  );
}
