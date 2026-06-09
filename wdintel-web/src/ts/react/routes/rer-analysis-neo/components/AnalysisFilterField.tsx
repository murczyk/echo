import { Autocomplete, Chip, TextField } from '@mui/material';
import { Box, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { ELLIPSIS } from '../../../utils/misc';

export type AnalysisFilterOption =
  | string
  | {
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
  normalizeUnknownAliases?: boolean;
  deferredCommit?: boolean;
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

function optionContainsValue(option: AutocompleteOption, selected: string, normalizeUnknownAliases: boolean): boolean {
  if (option.value === selected || option.values.includes(selected)) {
    return true;
  }
  return normalizeUnknownAliases && option.value === '' && (selected === '' || selected === 'Не визначено');
}

export function AnalysisFilterField({
  label,
  options,
  value,
  disabled,
  loading,
  normalizeUnknownAliases = false,
  deferredCommit = false,
  onChange,
}: Props) {
  const autocompleteOptions = options.map(toAutocompleteOption);
  const labelCacheRef = useRef<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState(value);
  const draftValueRef = useRef(value);

  const updateDraftValue = (nextValue: string[]) => {
    draftValueRef.current = nextValue;
    setDraftValue(nextValue);
  };

  autocompleteOptions.forEach((option) => {
    labelCacheRef.current[option.value] = option.label;
    option.values.forEach((value) => {
      labelCacheRef.current[value] = option.label;
    });
  });

  useEffect(() => {
    if (!open) {
      updateDraftValue(value);
    }
  }, [open, value]);

  const effectiveValue = deferredCommit && open ? draftValue : value;
  const autocompleteValue = autocompleteOptions.filter((option) => effectiveValue.some((selected) => optionContainsValue(option, selected, normalizeUnknownAliases)));
  const unknownAutocompleteValue = effectiveValue
    .filter((selected) => !autocompleteOptions.some((option) => optionContainsValue(option, selected, normalizeUnknownAliases)))
    .map((selected) => {
      const label = labelCacheRef.current[selected] ?? selected;
      return { key: selected, label, value: selected, count: 0, values: [selected] };
    });

  const commitValue = (nextValue: string[]) => {
    if (deferredCommit) {
      draftValueRef.current = nextValue;
      setDraftValue(nextValue);
    }
    onChange(nextValue);
  };

  return (
    <Autocomplete<AutocompleteOption, true, false, false>
      multiple
      disableCloseOnSelect
      open={open}
      size="small"
      options={autocompleteOptions}
      value={[...autocompleteValue, ...unknownAutocompleteValue]}
      disabled={disabled}
      loading={loading}
      loadingText={`Завантаження${ELLIPSIS}`}
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(option, selected) => option.value === selected.value}
      openText="Відкрити"
      closeText="Закрити"
      clearText="Очистити"
      noOptionsText={loading ? `Завантаження${ELLIPSIS}` : 'Немає варіантів'}
      onOpen={() => {
        setOpen(true);
        if (deferredCommit) {
          updateDraftValue(value);
        }
      }}
      onClose={() => {
        setOpen(false);
        if (deferredCommit) {
          onChange(draftValueRef.current);
        }
      }}
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
      onChange={(_event, next, reason) => {
        const nextValues = next.flatMap((option) => option.values);
        if (!deferredCommit || reason === 'clear' || (reason === 'removeOption' && !open)) {
          commitValue(nextValues);
          return;
        }
        updateDraftValue(nextValues);
      }}
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
