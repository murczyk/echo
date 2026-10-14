import { Autocomplete, TextField } from '@mui/material';
import { useMemo } from 'react';
import type { UnitResponse } from '../../../services/api/direct-submit';
import type { MessageFormData } from './manage-message-drawer.schema';
import { normalizeMessageUnitName } from './message-unit-name';
import { compatibleMessageUnitSelection } from './message-unit-selection';
import { PowerAlert } from '../../../components/PowerAlert';
import { UnitFormDrawer } from '../../rer-units-neo/components/UnitFormDrawer';
import { useMessageUnitCreation } from './useMessageUnitCreation';

type UnitOption = UnitResponse | { name: string; create: true };

type Props = {
  value: string;
  selection?: MessageFormData['unitSelection'];
  errorMessage?: string;
  options: UnitResponse[];
  loading: boolean;
  allowCreate: boolean;
  disabled: boolean;
  onFocus: () => void;
  onChange: (value: string, selection?: MessageFormData['unitSelection']) => void;
};

export function MessageUnitAutocomplete({
  value,
  selection,
  errorMessage,
  options,
  loading,
  allowCreate,
  disabled,
  onFocus,
  onChange,
}: Props) {
  const creation = useMessageUnitCreation((unit) =>
    onChange(unit.name, { id: unit.id, name: unit.name }),
  );
  const selectedValue = useMemo(
    () => compatibleMessageUnitSelection(value, selection) ?? value,
    [selection?.id, selection?.name, selection?.create, value],
  );
  const nameCounts = new Map<string, number>();
  for (const unit of options) {
    const name = normalizeMessageUnitName(unit.name);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  return (
    <>
      <Autocomplete<UnitOption, false, false, true>
        freeSolo
        forcePopupIcon
        noOptionsText="Немає варіантів"
        options={options}
        value={selectedValue}
        inputValue={value}
        loading={loading || creation.loading}
        disabled={disabled || creation.loading}
        getOptionLabel={(option) => (typeof option === 'string' ? option : option.name)}
        getOptionKey={(option) =>
          typeof option === 'string' ? option : 'id' in option ? option.id : 'create'
        }
        isOptionEqualToValue={(option, selected) => {
          if (typeof option === 'string' || typeof selected === 'string') return false;
          if ('id' in option && 'id' in selected) return option.id === selected.id;
          return (
            'create' in option &&
            'create' in selected &&
            normalizeMessageUnitName(option.name) === normalizeMessageUnitName(selected.name)
          );
        }}
        filterOptions={(units) => {
          const name = value.trim();
          if (name && allowCreate && !loading && units.length === 0) {
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
          } else if ('create' in option) {
            void creation.open(option.name);
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
            disabled={disabled || creation.loading}
            onFocus={onFocus}
            error={Boolean(errorMessage)}
            helperText={errorMessage}
          />
        )}
      />
      {creation.error && creation.form === null ? (
        <PowerAlert severity="error">{creation.error}</PowerAlert>
      ) : null}
      {creation.form !== null ? (
        <UnitFormDrawer
          open
          unit={null}
          initialName={creation.form.initialName}
          devicesSectionEnabled={creation.form.devicesSectionEnabled}
          hideNetworks={creation.form.hideNetworks}
          submitting={creation.submitting}
          error={creation.error}
          orbitUnits={[]}
          orbitLinksLoading={false}
          orbitLinksError={null}
          canLinkOrbitUnit={false}
          unlinkingOrbitUnitId={null}
          onClose={creation.close}
          onSubmit={(value) => void creation.submit(value)}
          onLinkOrbitUnit={() => undefined}
          onUnlinkOrbitUnit={() => undefined}
        />
      ) : null}
    </>
  );
}
