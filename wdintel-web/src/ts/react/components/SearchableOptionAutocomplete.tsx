import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Autocomplete, TextField } from '@mui/material';
import type { AutocompleteProps } from '@mui/material/Autocomplete';

import { createRankedFilterOptions } from '../utils/search-filter';

type SearchableOption = {
  id: number;
};

type Props<T extends SearchableOption> = {
  label: string;
  options: T[];
  valueId: number | null;
  onValueIdChange: (valueId: number | null) => void;
  getOptionLabel: (option: T) => string;
  disabled?: boolean;
  required?: boolean;
  size?: 'small' | 'medium';
  placeholder?: string;
  helperText?: ReactNode;
  error?: boolean;
  noOptionsText?: string;
  clearable?: boolean;
  inputValue?: string;
  onInputValueChange?: (value: string) => void;
  className?: string;
  disablePortal?: boolean;
  slotProps?: AutocompleteProps<T, false, false, false>['slotProps'];
};

export function SearchableOptionAutocomplete<T extends SearchableOption>({
  label,
  options,
  valueId,
  onValueIdChange,
  getOptionLabel,
  disabled = false,
  required = false,
  size = 'small',
  placeholder,
  helperText,
  error = false,
  noOptionsText = 'Нічого не знайдено',
  clearable = true,
  inputValue,
  onInputValueChange,
  className,
  disablePortal,
  slotProps,
}: Props<T>) {
  const selectedOption = useMemo(() => options.find((option) => option.id === valueId) ?? null, [options, valueId]);
  const selectedLabel = useMemo(() => (selectedOption ? getOptionLabel(selectedOption) : ''), [getOptionLabel, selectedOption]);
  const [internalInputValue, setInternalInputValue] = useState(() => selectedLabel);
  const controlledInput = inputValue !== undefined;
  const displayedInputValue = controlledInput ? inputValue : internalInputValue;
  const filterOptions = useMemo(() => createRankedFilterOptions(getOptionLabel), [getOptionLabel]);

  useEffect(() => {
    if (controlledInput) return;
    setInternalInputValue(selectedLabel);
  }, [controlledInput, selectedLabel]);

  const updateInputValue = (nextValue: string) => {
    if (controlledInput) {
      onInputValueChange?.(nextValue);
      return;
    }
    setInternalInputValue(nextValue);
  };

  return (
    <Autocomplete<T, false, boolean, false>
      fullWidth
      size={size}
      className={className}
      options={options}
      value={selectedOption}
      inputValue={displayedInputValue}
      disabled={disabled}
      disableClearable={!clearable}
      disablePortal={disablePortal}
      slotProps={slotProps}
      noOptionsText={noOptionsText}
      getOptionLabel={getOptionLabel}
      isOptionEqualToValue={(option, value) => option.id === value.id}
      filterOptions={filterOptions}
      onChange={(_, nextOption) => {
        onValueIdChange(nextOption?.id ?? null);
      }}
      onInputChange={(_event, nextValue, reason) => {
        if (reason === 'clear') {
          if (!clearable) {
            updateInputValue(selectedLabel);
            return;
          }

          updateInputValue(nextValue);
          onValueIdChange(null);
          return;
        }

        updateInputValue(nextValue);
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          required={required}
          placeholder={placeholder}
          error={error}
          helperText={helperText}
          size={size}
          onBlur={() => {
            if (!clearable && selectedOption) {
              updateInputValue(selectedLabel);
            }
          }}
        />
      )}
    />
  );
}
