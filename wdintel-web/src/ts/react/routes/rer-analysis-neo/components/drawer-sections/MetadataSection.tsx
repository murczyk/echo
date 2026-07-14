import React from 'react';
import { Box, TextField, Autocomplete, Stack, Typography, Chip } from '@mui/material';
import { useFormContext, Controller } from 'react-hook-form';
import { TimePicker } from '@mui/x-date-pickers/TimePicker';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { PowerDatePicker } from '../../../../components/PowerDateTimePicker';
import { FormSectionWrapper } from './FormSectionWrapper';
import { normalizeMultiValue, type MessageFormData } from '../manage-message-drawer.schema';

type Props = {
  isEditMode: boolean;
  showAdvanced: boolean;
  busy: boolean;
  recentValues: any;
  getProposedCallsigns: (current: string[]) => string[];
  addSuggestedCallsign: (callsign: string) => void;
  callsignOptions: string[];
  callsignLoading: boolean;
  setCallsignInput: (val: string) => void;
  tagOptions: string[];
  postOptions: string[];
  postLoading: boolean;
  setPostInput: (val: string) => void;
  unitOptions: string[];
  unitLoading: boolean;
  setUnitInput: (val: string) => void;
};

export function MetadataSection({
  isEditMode,
  showAdvanced,
  busy,
  recentValues,
  getProposedCallsigns,
  addSuggestedCallsign,
  callsignOptions,
  callsignLoading,
  setCallsignInput,
  tagOptions,
  postOptions,
  postLoading,
  setPostInput,
  unitOptions,
  unitLoading,
  setUnitInput,
}: Props) {
  const {
    control,
    formState: { errors },
  } = useFormContext<MessageFormData>();

  return (
    <>
      {/* Meta */}
      <FormSectionWrapper title="Дані повідомлення">
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
            gap: 2,
          }}
        >
          <Controller
            name="date"
            control={control}
            render={({ field }) => (
              <PowerDatePicker
                label="Дата перехоплення"
                value={field.value}
                allowEmpty
                onChange={(newValue) => field.onChange(newValue)}
                disabled={busy}
                slotProps={{ textField: { size: 'small', fullWidth: true } }}
              />
            )}
          />

          <Controller
            name="time"
            control={control}
            render={({ field }) => (
              <LocalizationProvider dateAdapter={AdapterDayjs} adapterLocale="uk">
                <TimePicker
                  label="Час перехоплення"
                  value={field.value ?? null}
                  ampm={false}
                  onChange={(newValue) => field.onChange(newValue)}
                  disabled={busy}
                  slotProps={{ textField: { size: 'small', fullWidth: true } }}
                />
              </LocalizationProvider>
            )}
          />
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
            gap: 2,
          }}
        >
          <Controller
            name="post"
            control={control}
            render={({ field }) => (
              <Autocomplete
                freeSolo
                forcePopupIcon
                noOptionsText="Немає варіантів"
                options={Array.from(new Set([...(recentValues?.post || []), ...postOptions]))}
                value={field.value ?? ''}
                loading={postLoading}
                disabled={busy}
                onInputChange={(_, newValue, reason) => {
                  if (reason === 'input') {
                    setPostInput(newValue);
                    field.onChange(newValue);
                  }
                }}
                onChange={(_, newValue) => field.onChange(newValue || '')}
                renderInput={(params) => (
                  <TextField {...params} label="Пост" size="small" fullWidth disabled={busy} />
                )}
              />
            )}
          />

          <Controller
            name="unit"
            control={control}
            render={({ field }) => (
              <Autocomplete
                forcePopupIcon
                noOptionsText="Немає варіантів"
                options={Array.from(new Set([...(recentValues?.unit || []), ...unitOptions]))}
                value={field.value ?? ''}
                loading={unitLoading}
                disabled={busy}
                onInputChange={(_, newValue, reason) => {
                  if (reason === 'input') {
                    setUnitInput(newValue);
                    field.onChange(newValue);
                  }
                }}
                onChange={(_, newValue) => field.onChange(newValue || '')}
                renderInput={(params) => (
                  <TextField {...params} label="Підрозділ" size="small" fullWidth disabled={busy} />
                )}
              />
            )}
          />
        </Box>

        <Controller
          name="tags"
          control={control}
          render={({ field }) => (
            <Autocomplete
              multiple
              noOptionsText="Немає варіантів"
              options={tagOptions}
              value={field.value || []}
              onChange={(_, newValue) => field.onChange(normalizeMultiValue(newValue as string[]))}
              renderInput={(params) => <TextField {...params} label="Теги" size="small" />}
              disabled={busy}
            />
          )}
        />
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
                onChange={(_, newValue) =>
                  field.onChange(normalizeMultiValue(newValue as string[]))
                }
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
    </>
  );
}
