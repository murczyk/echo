import { Autocomplete, TextField } from '@mui/material';
import type { AutocompleteProps } from '@mui/material/Autocomplete';
import { useMemo, type ReactNode } from 'react';

import { createRankedFilterOptions } from '../utils/search-filter';

type SearchableOption = {
  id: number;
};

type Props<T extends SearchableOption> = {
  label: string;
  options: T[];
  valueIds: number[];
  onValueIdsChange: (valueIds: number[]) => void;
  getOptionLabel: (option: T) => string;
  disabled?: boolean;
  required?: boolean;
  size?: 'small' | 'medium';
  helperText?: ReactNode;
  error?: boolean;
  noOptionsText?: string;
  className?: string;
  disablePortal?: boolean;
  onBlur?: () => void;
  loading?: boolean;
  loadingText?: string;
  slotProps?: AutocompleteProps<T, true, false, false>['slotProps'];
};

export function SearchableMultiOptionAutocomplete<T extends SearchableOption>({
  label,
  options,
  valueIds,
  onValueIdsChange,
  getOptionLabel,
  disabled = false,
  required = false,
  size = 'small',
  helperText,
  error = false,
  noOptionsText = 'Нічого не знайдено',
  className,
  disablePortal,
  onBlur,
  loading = false,
  loadingText,
  slotProps,
}: Props<T>) {
  const selectedOptions = useMemo(
    () => valueIds.map((valueId) => options.find((option) => option.id === valueId)).filter((option): option is T => option !== undefined),
    [options, valueIds],
  );
  const filterOptions = useMemo(() => createRankedFilterOptions(getOptionLabel), [getOptionLabel]);

  return (
    <Autocomplete<T, true, false, false>
      multiple
      disableCloseOnSelect
      filterSelectedOptions
      fullWidth
      size={size}
      className={className}
      options={options}
      value={selectedOptions}
      disabled={disabled}
      disablePortal={disablePortal}
      slotProps={slotProps}
      loading={loading}
      loadingText={loadingText}
      noOptionsText={noOptionsText}
      getOptionLabel={getOptionLabel}
      isOptionEqualToValue={(option, value) => option.id === value.id}
      filterOptions={filterOptions}
      onChange={(_, nextOptions) => {
        onValueIdsChange(nextOptions.map((option) => option.id));
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          required={required}
          error={error}
          helperText={helperText}
          size={size}
          onBlur={onBlur}
        />
      )}
    />
  );
}
