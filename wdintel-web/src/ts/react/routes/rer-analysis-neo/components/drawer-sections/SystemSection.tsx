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
  recentValues: any;
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
  recentValues,
}: Props) {
  const {
    control,
    formState: { errors },
  } = useFormContext<MessageFormData>();

  const sortedSignalGroups = React.useMemo(() => {
    if (!recentValues?.group || recentValues.group.length === 0) return signalGroups;

    return [...signalGroups].sort((a, b) => {
      let indexA = recentValues.group.indexOf(a.masterKey);
      let indexB = recentValues.group.indexOf(b.masterKey);

      if (indexA === -1) indexA = Infinity;
      if (indexB === -1) indexB = Infinity;

      return indexA - indexB;
    });
  }, [signalGroups, recentValues?.group]);

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
              options={sortedSignalGroups}
              noOptionsText="Немає варіантів"
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
                noOptionsText="Немає варіантів"
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
