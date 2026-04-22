import { Autocomplete, Chip, TextField } from '@mui/material';
import { Box, Typography } from '@mui/material';
import { useRef } from 'react';

export type AnalysisFilterOption = string | {
  value: string;
  label: string;
  count: number;
  values?: string[];
};

type AutocompleteOption = {
  key: string;
  label: string;
  value: string;
  count: number;
  values: string[];
};

type Props = {
  label: string;
  options: AnalysisFilterOption[];
  value: string[];
  disabled?: boolean;
  loading?: boolean;
  onChange: (next: string[]) => void;
};

function toAutocompleteOption(option: AnalysisFilterOption, index: number): AutocompleteOption {
  if (typeof option === 'string') {
    return { key: `${option}-${index}`, label: option, value: option, count: 0, values: [option] };
  }
  return {
    key: `${option.value}-${index}`,
    label: option.label,
    value: option.value,
    count: option.count,
    values: option.values ?? [option.value],
  };
}

function optionContainsValue(option: AutocompleteOption, selected: string): boolean {
  return option.value === selected || option.values.includes(selected);
}

export function AnalysisFilterField({ label, options, value, disabled, loading, onChange }: Props) {
  const autocompleteOptions = options.map(toAutocompleteOption);
  const labelCacheRef = useRef<Record<string, string>>({});
  autocompleteOptions.forEach((option) => {
    labelCacheRef.current[option.value] = option.label;
    option.values.forEach((value) => {
      labelCacheRef.current[value] = option.label;
    });
  });
  const autocompleteValue = autocompleteOptions.filter((option) => value.some((selected) => optionContainsValue(option, selected)));
  const unknownAutocompleteValue = value
    .filter((selected) => !autocompleteOptions.some((option) => optionContainsValue(option, selected)))
    .map((selected) => {
      const label = labelCacheRef.current[selected] ?? selected;
      return { key: selected, label, value: selected, count: 0, values: [selected] };
    });

  return (
    <Autocomplete<AutocompleteOption, true, false, false>
      multiple
      disableCloseOnSelect
      size="small"
      options={autocompleteOptions}
      value={[...autocompleteValue, ...unknownAutocompleteValue]}
      disabled={disabled}
      loading={loading}
      loadingText="Завантаження..."
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(option, selected) => option.value === selected.value}
      openText="Відкрити"
      closeText="Закрити"
      clearText="Очистити"
      noOptionsText={loading ? 'Завантаження...' : 'Немає варіантів'}
      renderTags={(tagValue, getTagProps) =>
        tagValue.map((option, index) => {
          const tagProps = getTagProps({ index });
          return (
            <Chip
              {...tagProps}
              key={option.key}
              title={option.label}
              label={
                <Typography variant="body2" noWrap sx={{ maxWidth: '100%' }}>
                  {option.label}
                </Typography>
              }
              size="small"
            />
          );
        })
      }
      onChange={(_event, next) => onChange(next.flatMap((option) => option.values))}
      renderOption={(props, option) => {
        const { key: _unusedKey, ...optionProps } = props;
        return (
          <li {...optionProps} key={option.key} title={option.label}>
            <Box sx={{ display: 'flex', minWidth: 0, width: '100%', alignItems: 'center', gap: 1 }}>
              <Typography variant="body2" sx={{ minWidth: 0, flex: 1 }} noWrap title={option.label}>
                {option.label}
              </Typography>
              <Typography variant="body2" sx={{ flexShrink: 0, whiteSpace: 'nowrap', color: 'text.secondary' }}>
                {option.count}
              </Typography>
            </Box>
          </li>
        );
      }}
      renderInput={(params) => <TextField {...params} label={label} />}
    />
  );
}
