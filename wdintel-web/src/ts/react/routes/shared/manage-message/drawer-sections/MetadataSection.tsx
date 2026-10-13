import { useRadioFeatures } from '../../RadioFeatures';
import React from 'react';
import { Box, TextField, Autocomplete, Stack } from '@mui/material';
import { useFormContext, Controller } from 'react-hook-form';
import { TimePicker } from '@mui/x-date-pickers/TimePicker';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { PowerDatePicker } from '../../../../components/PowerDateTimePicker';
import { FormSectionWrapper } from './FormSectionWrapper';
import { ParserFieldFeedback } from '../MessageParserFeedback';
import { MessageUnitAutocomplete } from '../MessageUnitAutocomplete';
import type { UnitResponse } from '../../../../services/api/direct-submit';
import {
  normalizeCallsign,
  normalizeMultiValue,
  type MessageFormData,
} from '../manage-message-drawer.schema';

type Props = {
  showAdvanced: boolean;
  busy: boolean;
  recentValues: any;
  callsignOptions: string[];
  callsignLoading: boolean;
  callsignInput: string;
  setCallsignInput: (val: string) => void;
  tagOptions: string[];
  postOptions: string[];
  postLoading: boolean;
  setPostInput: (val: string) => void;
  unitOptions: UnitResponse[];
  unitLoading: boolean;
  unitLocked: boolean;
};

export function MetadataSection({
  showAdvanced,
  busy,
  recentValues,
  callsignOptions,
  callsignLoading,
  callsignInput,
  setCallsignInput,
  tagOptions,
  postOptions,
  postLoading,
  setPostInput,
  unitOptions,
  unitLoading,
  unitLocked,
}: Props) {
  const radioFeaturesAllowed = useRadioFeatures();
  const {
    control,
    setValue,
    formState: { errors },
  } = useFormContext<MessageFormData>();

  return (
    <>
      {/* Meta */}
      <FormSectionWrapper title="Дані повідомлення">
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'repeat(var(--manage-message-metadata-columns, 2), minmax(0, 1fr))',
            },
            gap: 2,
          }}
        >
          <ParserFieldFeedback field="date" label="дату">
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
          </ParserFieldFeedback>

          <ParserFieldFeedback field="time" label="час">
            <Controller
              name="time"
              control={control}
              render={({ field, fieldState }) => (
                <LocalizationProvider dateAdapter={AdapterDayjs} adapterLocale="uk">
                  <TimePicker
                    label="Час перехоплення"
                    value={field.value ?? null}
                    ampm={false}
                    onChange={(newValue) => field.onChange(newValue)}
                    disabled={busy}
                    slotProps={{
                      field: { clearable: true },
                      clearButton: { title: 'Очистити час', 'aria-label': 'Очистити час' },
                      textField: {
                        size: 'small',
                        fullWidth: true,
                        error: Boolean(fieldState.error),
                        helperText: fieldState.error?.message,
                      },
                    }}
                  />
                </LocalizationProvider>
              )}
            />
          </ParserFieldFeedback>
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'repeat(var(--manage-message-section-columns, 2), minmax(0, 1fr))',
            },
            gap: 2,
          }}
        >
          {radioFeaturesAllowed ? (
            <ParserFieldFeedback field="post" label="пост">
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
            </ParserFieldFeedback>
          ) : null}

          <ParserFieldFeedback field="unit" label="підрозділ">
            <Controller
              name="unit"
              control={control}
              render={({ field }) => (
                <MessageUnitAutocomplete
                  options={unitOptions}
                  value={field.value ?? ''}
                  loading={unitLoading}
                  disabled={busy || unitLocked}
                  onChange={(name, selection) => {
                    field.onChange(name);
                    setValue('unitSelection', selection, { shouldDirty: true });
                  }}
                />
              )}
            />
          </ParserFieldFeedback>
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
        <ParserFieldFeedback field="callsigns" label="позивні">
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
                    new Set(
                      [...(recentValues?.callsigns || []), ...callsignOptions].map(
                        normalizeCallsign,
                      ),
                    ),
                  )}
                  value={field.value || []}
                  inputValue={callsignInput}
                  loading={callsignLoading}
                  onInputChange={(_, newValue) => setCallsignInput(normalizeCallsign(newValue))}
                  onChange={(_, newValue) =>
                    field.onChange(
                      normalizeMultiValue((newValue as string[]).map(normalizeCallsign)),
                    )
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
              </Stack>
            )}
          />
        </ParserFieldFeedback>
      </FormSectionWrapper>
    </>
  );
}
