import { Box, TextField, Autocomplete, Typography } from '@mui/material';
import { useFormContext, Controller, useWatch } from 'react-hook-form';
import { FormSectionWrapper } from './FormSectionWrapper';
import { normalizeMultiValue, type MessageFormData } from '../manage-message-drawer.schema';
import type { SettlementDetails } from '../../../../services/api/settlements';
import { useSettlementAutocomplete } from './useSettlementAutocomplete';

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
    formState: { errors },
  } = useFormContext<MessageFormData>();
  const coordsText = useWatch({ control, name: 'coords' });
  const signalGroupMasterKey = useWatch({ control, name: 'signalGroupMasterKey' });
  const { settlementOptions, loading, onInputChange } = useSettlementAutocomplete({
    open,
    busy,
    coordsText,
    signalGroupMasterKey: signalGroupMasterKey?.trim() || null,
    onError,
  });
  const options: LocationAutocompleteOption[] = [
    ...(recentValues?.locations ?? []).map((name: string, index: number) => ({
      kind: 'recent' as const,
      key: `recent:${name}:${index}`,
      name,
    })),
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
            renderInput={(params) => <TextField {...params} label="Назви локацій" size="small" />}
            disabled={busy}
          />
        )}
      />

      <Controller
        name="coords"
        control={control}
        render={({ field }) => (
          <TextField
            {...field}
            label="Координати (lat, lon або MGRS)"
            fullWidth
            error={!!errors.coords}
            helperText={errors.coords?.message ?? null}
            disabled={busy}
            placeholder="49.12345, 37.12345"
          />
        )}
      />
    </FormSectionWrapper>
  );
}
