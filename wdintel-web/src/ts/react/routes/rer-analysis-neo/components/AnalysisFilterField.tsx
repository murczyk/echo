import { Autocomplete, TextField } from '@mui/material';

export type AnalysisFilterOption = string | { value: string; label: string; values?: string[] };

type AutocompleteOption = {
  key: string;
  label: string;
  value: string;
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
    return { key: `${option}-${index}`, label: option, value: option, values: [option] };
  }
  return { key: option.value, label: option.label, value: option.value, values: option.values ?? [option.value] };
}

function optionContainsValue(option: AutocompleteOption, selected: string): boolean {
  return option.value === selected || option.values.includes(selected);
}

export function AnalysisFilterField({ label, options, value, disabled, loading, onChange }: Props) {
  const autocompleteOptions = options.map(toAutocompleteOption);
  const autocompleteValue = autocompleteOptions.filter((option) => value.some((selected) => optionContainsValue(option, selected)));
  const unknownAutocompleteValue = value
    .filter((selected) => !autocompleteOptions.some((option) => optionContainsValue(option, selected)))
    .map((selected) => ({ key: selected, label: selected, value: selected, values: [selected] }));

  return (
    <Autocomplete<AutocompleteOption, true, false, false>
      multiple
      size="small"
      options={autocompleteOptions}
      value={[...autocompleteValue, ...unknownAutocompleteValue]}
      disabled={disabled}
      loading={loading}
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(option, selected) => option.value === selected.value}
      openText="Відкрити"
      closeText="Закрити"
      clearText="Очистити"
      noOptionsText="Немає варіантів"
      onChange={(_event, next) => onChange(next.flatMap((option) => option.values))}
      renderOption={(props, option) => {
        const { key: _unusedKey, ...optionProps } = props;
        return (
          <li {...optionProps} key={option.key}>
            {option.label}
          </li>
        );
      }}
      renderInput={(params) => <TextField {...params} label={label} />}
    />
  );
}
