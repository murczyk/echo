import { Box, Chip, TextField, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import { ELLIPSIS } from '../../../utils/misc';
import { PowerAutocomplete } from '../../../components/PowerAutocomplete';

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
  emptyLoading?: boolean;
  normalizeUnknownAliases?: boolean;
  deferredCommit?: boolean;
  preserveSelectionOrder?: boolean;
  preserveSelectedOptionValuesOnChange?: boolean;
  bulkPaste?: boolean;
  bulkPasteSeparators?: string[];
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

function optionContainsValue(
  option: AutocompleteOption,
  selected: string,
  normalizeUnknownAliases: boolean,
): boolean {
  if (option.value === selected || option.values.includes(selected)) {
    return true;
  }
  return (
    normalizeUnknownAliases &&
    option.value === '' &&
    (selected === '' || selected === 'Не визначено')
  );
}

function buildSelectedOptions(
  selectedValues: string[],
  autocompleteOptions: AutocompleteOption[],
  normalizeUnknownAliases: boolean,
  preserveSelectionOrder: boolean,
  labelCache: Record<string, string>,
): AutocompleteOption[] {
  if (!preserveSelectionOrder) {
    return [
      ...autocompleteOptions.filter((option) =>
        selectedValues.some((selected) =>
          optionContainsValue(option, selected, normalizeUnknownAliases),
        ),
      ),
      ...selectedValues
        .filter(
          (selected) =>
            !autocompleteOptions.some((option) =>
              optionContainsValue(option, selected, normalizeUnknownAliases),
            ),
        )
        .map((selected) => {
          const label = labelCache[selected] ?? selected;
          return { key: selected, label, value: selected, count: 0, values: [selected] };
        }),
    ];
  }

  const selectedOptions: AutocompleteOption[] = [];
  const seenKeys = new Set<string>();
  selectedValues.forEach((selected) => {
    const option = autocompleteOptions.find((candidate) =>
      optionContainsValue(candidate, selected, normalizeUnknownAliases),
    );
    if (option != null) {
      if (seenKeys.has(option.key)) return;
      seenKeys.add(option.key);
      selectedOptions.push(option);
      return;
    }

    if (seenKeys.has(selected)) return;
    seenKeys.add(selected);
    const label = labelCache[selected] ?? selected;
    selectedOptions.push({ key: selected, label, value: selected, count: 0, values: [selected] });
  });

  return selectedOptions;
}

function buildCommittedValues(
  next: AutocompleteOption[],
  currentValues: string[],
  preserveSelectedOptionValuesOnChange: boolean,
): string[] {
  if (!preserveSelectedOptionValuesOnChange) {
    return next.flatMap((option) => option.values);
  }

  const currentValueSet = new Set(currentValues);
  const committedValues: string[] = [];
  const seenValues = new Set<string>();

  next.forEach((option) => {
    const preservedValues = option.values.filter((value) => currentValueSet.has(value));
    const valuesToCommit = preservedValues.length > 0 ? preservedValues : option.values;
    valuesToCommit.forEach((value) => {
      if (seenValues.has(value)) return;
      seenValues.add(value);
      committedValues.push(value);
    });
  });

  return committedValues;
}

export function AnalysisFilterField({
  label,
  options,
  value,
  disabled,
  loading,
  emptyLoading = false,
  normalizeUnknownAliases = false,
  deferredCommit = false,
  preserveSelectionOrder = false,
  preserveSelectedOptionValuesOnChange = false,
  bulkPaste = false,
  bulkPasteSeparators,
  onChange,
}: Props) {
  const autocompleteOptions = options.map(toAutocompleteOption);
  const labelCacheRef = useRef<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState(value);
  const [inputValue, setInputValue] = useState('');
  const draftValueRef = useRef(value);
  const lastCommittedValueRef = useRef(value);

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
    lastCommittedValueRef.current = value;
  }, [open, value]);

  const effectiveValue = deferredCommit && open ? draftValue : value;
  const autocompleteValue = buildSelectedOptions(
    effectiveValue,
    autocompleteOptions,
    normalizeUnknownAliases,
    preserveSelectionOrder,
    labelCacheRef.current,
  );

  const commitValue = (nextValue: string[]) => {
    draftValueRef.current = nextValue;
    lastCommittedValueRef.current = nextValue;
    setDraftValue(nextValue);
    onChange(nextValue);
  };

  const handleBulkPasteChange = (next: AutocompleteOption[]) => {
    const nextValues = buildCommittedValues(
      next,
      effectiveValue,
      preserveSelectedOptionValuesOnChange,
    );
    commitValue(nextValues);
    clearInputValue();
  };

  const clearInputValue = () => {
    setInputValue('');
  };

  return (
    <PowerAutocomplete<AutocompleteOption>
      disableCloseOnSelect
      open={open}
      size="small"
      options={autocompleteOptions}
      value={autocompleteValue}
      inputValue={inputValue}
      disabled={disabled}
      loading={loading}
      loadingText={`Завантаження${ELLIPSIS}`}
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(option, selected) => option.value === selected.value}
      bulkPaste={bulkPaste}
      bulkPasteSeparators={bulkPasteSeparators}
      onBulkPasteChange={bulkPaste ? handleBulkPasteChange : undefined}
      openText="Відкрити"
      closeText="Закрити"
      clearText="Очистити"
      noOptionsText={loading || emptyLoading ? `Завантаження${ELLIPSIS}` : 'Немає варіантів'}
      onOpen={() => {
        setOpen(true);
        if (deferredCommit) {
          updateDraftValue(value);
        }
      }}
      onClose={() => {
        setOpen(false);
        if (deferredCommit) {
          if (
            draftValueRef.current.length !== lastCommittedValueRef.current.length ||
            !draftValueRef.current.every(
              (item, index) => item === lastCommittedValueRef.current[index],
            )
          ) {
            commitValue(draftValueRef.current);
          }
        }
      }}
      onInputChange={(_event, nextInputValue, reason) => {
        if (reason === 'reset') {
          return;
        }
        setInputValue(nextInputValue);
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
        const nextValues = buildCommittedValues(
          next,
          effectiveValue,
          preserveSelectedOptionValuesOnChange,
        );
        if (deferredCommit && open) {
          updateDraftValue(nextValues);
        } else {
          commitValue(nextValues);
        }
        if (reason !== 'blur') {
          clearInputValue();
        }
      }}
      renderOption={(props, option) => {
        const { key: _unusedKey, ...optionProps } = props;
        return (
          <li {...optionProps} key={option.key} title={option.label}>
            <Box sx={{ display: 'flex', minWidth: 0, width: '100%', alignItems: 'center', gap: 1 }}>
              <Typography variant="body2" sx={{ minWidth: 0, flex: 1 }} noWrap title={option.label}>
                {option.label}
              </Typography>
              <Typography
                variant="body2"
                sx={{ flexShrink: 0, whiteSpace: 'nowrap', color: 'text.secondary' }}
              >
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
