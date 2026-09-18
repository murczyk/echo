import { Box, TextField, Autocomplete, CircularProgress, Typography } from '@mui/material';
import { useFormContext, Controller, useWatch } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import {
  DO_NOT_SEND_GROUP_VALUE,
  normalizeMultiValue,
  type MessageFormData,
} from '../manage-message-drawer.schema';
import type { SettlementDetails } from '../../../../services/api/settlements';
import { useSettlementAutocomplete } from './useSettlementAutocomplete';
import { CoordinateInputPreview } from './CoordinateInputPreview';
import { CoordinateListInput } from './CoordinateListInput';

type LocationAutocompleteOption =
  | { kind: 'recent'; key: string; name: string }
  | { kind: 'settlement'; key: string; settlement: SettlementDetails };

type AutocompleteValue = string | LocationAutocompleteOption;

type Props = {
  busy: boolean;
  recentValues: any;
  open: boolean;
  onError: (message: string) => void;
};

function optionToLocationName(value: AutocompleteValue): string {
  if (typeof value === 'string') return value;
  return value.kind === 'recent' ? value.name : value.settlement.name;
}

function optionKey(option: AutocompleteValue): string {
  if (typeof option === 'string') return `free:${option}`;
  return option.key;
}

export function LocationsSection({ busy, recentValues, open, onError }: Props) {
  const {
    control,
    clearErrors,
    setError,
    formState: { errors },
  } = useFormContext<MessageFormData>();
  const coordsText = useWatch({ control, name: 'coords' });
  const signalGroupMasterKey = useWatch({ control, name: 'signalGroupMasterKey' });
  const settlementGroupMasterKey = signalGroupMasterKey?.trim();
  const { settlementOptions, loading, hasLocationQuery, onInputChange } = useSettlementAutocomplete(
    {
      open,
      busy,
      coordsText,
      signalGroupMasterKey:
        settlementGroupMasterKey && settlementGroupMasterKey !== DO_NOT_SEND_GROUP_VALUE
          ? settlementGroupMasterKey
          : null,
      onError,
    },
  );
  const options: LocationAutocompleteOption[] = [
    ...(hasLocationQuery
      ? []
      : (recentValues?.locations ?? []).map((name: string, index: number) => ({
          kind: 'recent' as const,
          key: `recent:${name}:${index}`,
          name,
        }))),
    ...settlementOptions.map((settlement, index) => ({
      kind: 'settlement' as const,
      key: [
        'settlement',
        settlement.id ?? 'none',
        settlement.name,
        settlement.region,
        settlement.language,
        settlement.coords?.join(',') ?? 'none',
        index,
      ].join(':'),
      settlement,
    })),
  ];

  return (
    <FormSectionWrapper title="Локації та координати">
      <Controller
        name="locations"
        control={control}
        render={({ field }) => (
          <Autocomplete<LocationAutocompleteOption, true, false, true>
            multiple
            freeSolo
            autoSelect
            forcePopupIcon
            options={options}
            value={field.value || []}
            onChange={(_, newValue) =>
              field.onChange(
                normalizeMultiValue((newValue as AutocompleteValue[]).map(optionToLocationName)),
              )
            }
            onInputChange={(_, value, reason) => onInputChange(value, reason)}
            loading={loading}
            filterOptions={(items) => items}
            getOptionLabel={(option) =>
              typeof option === 'string'
                ? option
                : option.kind === 'recent'
                  ? option.name
                  : option.settlement.name
            }
            getOptionKey={optionKey}
            isOptionEqualToValue={(option, value) => optionKey(option) === optionKey(value)}
            renderOption={(props, option) => (
              <li {...props} key={optionKey(option)}>
                {option.kind === 'settlement' ? (
                  <Box>
                    <Typography>{option.settlement.name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {option.settlement.region}
                    </Typography>
                  </Box>
                ) : (
                  option.name
                )}
              </li>
            )}
            noOptionsText="Немає варіантів"
            loadingText="Пошук локацій…"
            renderInput={(params) => (
              <TextField
                {...params}
                label="Назви локацій"
                size="small"
                slotProps={{
                  input: {
                    ...params.InputProps,
                    endAdornment: (
                      <>
                        {loading ? <CircularProgress color="inherit" size={20} /> : null}
                        {params.InputProps?.endAdornment}
                      </>
                    ),
                  },
                }}
              />
            )}
            disabled={busy}
          />
        )}
      />

      <Controller
        name="coords"
        control={control}
        render={({ field }) => (
          <CoordinateListInput
            value={field.value ?? ''}
            onChange={field.onChange}
            onBlur={field.onBlur}
            onErrorChange={(message) => {
              if (message) setError('coords', { type: 'manual', message });
              else clearErrors('coords');
            }}
            disabled={busy}
            error={errors.coords?.message}
            previewSlot={
              <CoordinateInputPreview value={coordsText ?? ''} busy={busy} onError={onError} />
            }
          />
        )}
      />
    </FormSectionWrapper>
  );
}
