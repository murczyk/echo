import React from 'react';
import { Box, TextField, Autocomplete, CircularProgress } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useFormContext, Controller } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import type { SignalGroupEntry } from '../../../../../../Bindings';
import { DO_NOT_SEND_GROUP_VALUE, type MessageFormData } from '../manage-message-drawer.schema';

const DO_NOT_SEND_GROUP_OPTION = {
  masterKey: DO_NOT_SEND_GROUP_VALUE,
  name: 'Не відправляти',
};

type SignalGroupOption = Pick<SignalGroupEntry, 'masterKey' | 'name'>;

type Props = {
  signalGroups: SignalGroupEntry[];
  groupsLoading: boolean;
  busy: boolean;
  isEditMode: boolean;
  isReportMode?: boolean;
  groupEditable?: boolean;
  cyberEchoEnabled: boolean;
  deviceNameOptions: string[];
  deviceNamesLoading: boolean;
  setDeviceNameInput: (value: string) => void;
  recentValues: any;
};

export function SystemSection({
  signalGroups,
  groupsLoading,
  busy,
  isEditMode,
  isReportMode = false,
  groupEditable = false,
  cyberEchoEnabled,
  deviceNameOptions,
  deviceNamesLoading,
  setDeviceNameInput,
  recentValues,
}: Props) {
  const theme = useTheme();
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
  const signalGroupOptions: SignalGroupOption[] = isReportMode
    ? [DO_NOT_SEND_GROUP_OPTION, ...sortedSignalGroups]
    : sortedSignalGroups;

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
              options={signalGroupOptions}
              noOptionsText="Немає варіантів"
              getOptionLabel={(option) => option.name || option.masterKey}
              isOptionEqualToValue={(option, value) => option.masterKey === value.masterKey}
              renderOption={(props, option) => {
                const { key, ...restProps } = props as any;
                const isDoNotSend = option.masterKey === DO_NOT_SEND_GROUP_VALUE;
                return (
                  <li
                    key={option.masterKey}
                    {...restProps}
                    style={isDoNotSend ? { color: theme.palette.error.main } : undefined}
                  >
                    {option.name || option.masterKey}
                  </li>
                );
              }}
              loading={groupsLoading}
              disabled={busy || (isEditMode && !groupEditable)}
              value={signalGroupOptions.find((group) => group.masterKey === field.value) || null}
              onChange={(_, newValue) => field.onChange(newValue?.masterKey || '')}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={isReportMode ? 'Відправити в групу' : 'Група'}
                  size="small"
                  fullWidth
                  required
                  error={!!errors.signalGroupMasterKey}
                  helperText={errors.signalGroupMasterKey?.message}
                  disabled={busy || (isEditMode && !groupEditable) || groupsLoading}
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
            name="deviceName"
            control={control}
            render={({ field }) => (
              <Autocomplete
                freeSolo
                forcePopupIcon
                noOptionsText="Немає варіантів"
                options={Array.from(
                  new Set([...(recentValues?.deviceName || []), ...deviceNameOptions]),
                )}
                loading={deviceNamesLoading}
                value={field.value ?? ''}
                disabled={busy}
                onInputChange={(_, newValue, reason) => {
                  if (reason !== 'input') return;
                  setDeviceNameInput(newValue);
                  field.onChange(newValue);
                }}
                onChange={(_, newValue) => {
                  const resolved = newValue || '';
                  setDeviceNameInput(resolved);
                  field.onChange(resolved);
                }}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Назва пристрою"
                    size="small"
                    fullWidth
                    disabled={busy}
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
