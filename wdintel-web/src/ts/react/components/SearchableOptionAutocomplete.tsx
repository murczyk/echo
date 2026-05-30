import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Autocomplete, TextField } from '@mui/material';
import type { AutocompleteProps } from '@mui/material/Autocomplete';

import { createRankedFilterOptions } from '../utils/search-filter';
import type { SearchableOption, SearchableOptionSelection } from './searchable-option.types';

export type { SearchableOptionSelection } from './searchable-option.types';
export { selectionFromId } from './searchable-option.types';

type BaseProps<T extends SearchableOption> = {
  options: T[];
  getOptionLabel: (option: T) => string;
  getStoredValue: (option: T) => string;
  label?: string;
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
  filterSelectedOptions?: boolean;
  slotProps?: AutocompleteProps<T, boolean, boolean, false>['slotProps'];
};

type SingleProps<T extends SearchableOption> = BaseProps<T> & {
  multiple?: false;
  value: SearchableOptionSelection | null;
  onChange: (value: SearchableOptionSelection | null) => void;
};

type MultiProps<T extends SearchableOption> = BaseProps<T> & {
  multiple: true;
  value: SearchableOptionSelection[];
  onChange: (value: SearchableOptionSelection[]) => void;
};

export type SearchableOptionAutocompleteProps<T extends SearchableOption> =
  | SingleProps<T>
  | MultiProps<T>;

export function SearchableOptionAutocomplete<T extends SearchableOption>(
  props: SearchableOptionAutocompleteProps<T>,
) {
  if (props.multiple) {
    return <MultiSearchableOptionAutocomplete {...props} />;
  }
  return <SingleSearchableOptionAutocomplete {...props} />;
}

function SingleSearchableOptionAutocomplete<T extends SearchableOption>({
  label,
  options,
  value,
  onChange,
  getOptionLabel,
  getStoredValue,
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
}: SingleProps<T>) {
  const selectedOption = useMemo(() => {
    if (value === null) return null;
    return options.find((option) => option.id === value.id) ?? null;
  }, [options, value]);
  const selectedLabel = useMemo(
    () => (selectedOption ? getOptionLabel(selectedOption) : ''),
    [getOptionLabel, selectedOption],
  );
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
      isOptionEqualToValue={(option, nextValue) => option.id === nextValue.id}
      filterOptions={filterOptions}
      onChange={(_, nextOption) => {
        onChange(
          nextOption ? { id: nextOption.id, value: getStoredValue(nextOption) } : null,
        );
      }}
      onInputChange={(event, nextValue, reason) => {
        if (reason === 'clear') {
          if (!clearable) {
            updateInputValue(selectedLabel);
            return;
          }

          updateInputValue(nextValue);
          onChange(null);
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

function MultiSearchableOptionAutocomplete<T extends SearchableOption>({
  label,
  options,
  value,
  onChange,
  getOptionLabel,
  getStoredValue,
  disabled = false,
  required = false,
  size = 'small',
  placeholder,
  helperText,
  error = false,
  noOptionsText = 'Нічого не знайдено',
  clearable = true,
  className,
  disablePortal,
  filterSelectedOptions,
  slotProps,
}: MultiProps<T>) {
  const valueKey = useMemo(() => value.map((selection) => selection.id).join(','), [value]);
  const selectedOptions = useMemo(
    () =>
      value.flatMap((selection) => {
        const option = options.find((item) => item.id === selection.id);
        return option ? [option] : [];
      }),
    [options, valueKey],
  );
  const filterOptions = useMemo(() => createRankedFilterOptions(getOptionLabel), [getOptionLabel]);
  const [inputValue, setInputValue] = useState('');
  const applyResetAfterSelectionRef = useRef(false);

  return (
    <Autocomplete<T, true, boolean, false>
      multiple
      fullWidth
      size={size}
      className={className}
      options={options}
      value={selectedOptions}
      inputValue={inputValue}
      disabled={disabled}
      disableClearable={!clearable}
      disablePortal={disablePortal}
      filterSelectedOptions={filterSelectedOptions}
      clearOnEscape
      slotProps={slotProps}
      noOptionsText={noOptionsText}
      getOptionLabel={getOptionLabel}
      isOptionEqualToValue={(option, nextValue) => option.id === nextValue.id}
      filterOptions={filterOptions}
      onChange={(_, nextOptions) => {
        applyResetAfterSelectionRef.current = true;
        onChange(
          nextOptions.map((option) => ({
            id: option.id,
            value: getStoredValue(option),
          })),
        );
      }}
      onInputChange={(_, nextValue, reason) => {
        if (reason === 'reset') {
          if (applyResetAfterSelectionRef.current) {
            applyResetAfterSelectionRef.current = false;
            setInputValue(nextValue);
          }
          return;
        }

        setInputValue(nextValue);
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
        />
      )}
    />
  );
}
