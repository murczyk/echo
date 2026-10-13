import React from 'react';
import { Autocomplete, TextField } from '@mui/material';
import type { UnitResponse } from '../../../services/api/direct-submit';
import type { MessageFormData } from './manage-message-drawer.schema';

type UnitOption = UnitResponse | { name: string; create: true };

type Props = {
  value: string;
  options: UnitResponse[];
  loading: boolean;
  disabled: boolean;
  onChange: (value: string, selection?: MessageFormData['unitSelection']) => void;
};

export function MessageUnitAutocomplete({ value, options, loading, disabled, onChange }: Props) {
  return (
    <Autocomplete<UnitOption, false, false, true>
      freeSolo
      forcePopupIcon
      noOptionsText="Немає варіантів"
      options={options}
      value={value}
      loading={loading}
      disabled={disabled}
      getOptionLabel={(option) => (typeof option === 'string' ? option : option.name)}
      getOptionKey={(option) =>
        typeof option === 'string' ? option : 'id' in option ? option.id : 'create'
      }
      filterOptions={(units) => {
        const name = value.trim();
        if (
          name &&
          !loading &&
          !units.some((unit) => unit.name.trim().toLowerCase() === name.toLowerCase())
        ) {
          return [...units, { name, create: true }];
        }
        return units;
      }}
      onInputChange={(_, name, reason) => {
        if (reason === 'input' || reason === 'clear') {
          onChange(name);
        }
      }}
      onChange={(_, option) => {
        if (typeof option === 'string' || option === null) {
          onChange(option ?? '');
        } else {
          onChange(option.name, option);
        }
      }}
      renderOption={(props, option) => (
        <li {...props}>{'create' in option ? `Додати Підрозділ «${option.name}»` : option.name}</li>
      )}
      renderInput={(params) => (
        <TextField {...params} label="Підрозділ" size="small" fullWidth disabled={disabled} />
      )}
    />
  );
}
