import React from 'react';
import { Box, TextField, Autocomplete } from '@mui/material';
import { useFormContext, Controller } from 'react-hook-form';
import { TimePicker } from '@mui/x-date-pickers/TimePicker';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { PowerDatePicker } from '../../../../components/PowerDateTimePicker';
import { FormSectionWrapper } from './FormSectionWrapper';
import { normalizeMultiValue, type MessageFormData } from '../create-message-drawer.schema';

type Props = {
  isEditMode: boolean;
  showAdvanced: boolean;
  busy: boolean;
  recentValues: any;
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
      {/* Short message (advanced, create-only) */}
      {!isEditMode && showAdvanced && (
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
      )}

      {/* Meta */}
      <FormSectionWrapper title="Метадані повідомлення">
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
      </FormSectionWrapper>
    </>
  );
}
