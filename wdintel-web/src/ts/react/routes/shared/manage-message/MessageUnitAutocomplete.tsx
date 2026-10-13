import { Autocomplete, TextField } from '@mui/material';
import type { UnitResponse } from '../../../services/api/direct-submit';
import type { MessageFormData } from './manage-message-drawer.schema';
import { normalizeMessageUnitName } from './message-unit-name';

type UnitOption = UnitResponse | { name: string; create: true };

type Props = {
  value: string;
  options: UnitResponse[];
  loading: boolean;
  allowCreate: boolean;
  disabled: boolean;
  onFocus: () => void;
  onChange: (value: string, selection?: MessageFormData['unitSelection']) => void;
};

export function MessageUnitAutocomplete({
  value,
  options,
  loading,
  allowCreate,
  disabled,
  onFocus,
  onChange,
}: Props) {
  const nameCounts = new Map<string, number>();
  for (const unit of options) {
    const name = normalizeMessageUnitName(unit.name);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
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
          allowCreate &&
          !loading &&
          !units.some(
            (unit) => normalizeMessageUnitName(unit.name) === normalizeMessageUnitName(name),
          )
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
      renderOption={({ key, ...props }, option) => (
        <li key={key} {...props}>
          {'create' in option
            ? `Додати Підрозділ «${option.name}»`
            : (nameCounts.get(normalizeMessageUnitName(option.name)) ?? 0) > 1
              ? `${option.name} · №${option.id}`
              : option.name}
        </li>
      )}
      renderInput={(params) => (
        <TextField
          {...params}
          label="Підрозділ"
          size="small"
          fullWidth
          disabled={disabled}
          onFocus={onFocus}
        />
      )}
    />
  );
}
