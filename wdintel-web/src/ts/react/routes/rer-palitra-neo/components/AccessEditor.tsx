import {
  Autocomplete,
  CircularProgress,
  Chip,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
} from '@mui/material';
import { memo, useMemo } from 'react';

import { AreaOfResponsibility, MyScope, Organism, User } from '../../../../../Bindings';
import { ELLIPSIS } from '../../../utils/misc';
import {
  accessTypeLabel,
  applyRestrictedAccess,
  canEditScopedLogins,
  isAccessRestricted,
  normalizeLogins,
  withDefaultOrganismAccess,
} from '../helpers';
import { AccessType, PalitraFormState } from '../types';

type Props = {
  form: PalitraFormState;
  onChange: (next: PalitraFormState) => void;
  readOnly?: boolean;
  user: User | null;
  myScope: MyScope | null;
  organisms: Organism[];
  aors: AreaOfResponsibility[];
  allLogins: string[];
  availableAccessTypes: AccessType[];
  loading?: boolean;
};

function AccessEditorComponent({
  form,
  onChange,
  readOnly = false,
  user,
  myScope,
  organisms,
  aors,
  allLogins,
  availableAccessTypes,
  loading = false,
}: Props) {
  const restrictedByRole = isAccessRestricted(user);
  const loginSelectionAllowed = canEditScopedLogins(user);
  const restricted = restrictedByRole || readOnly || loading;
  const restrictLogins = (restrictedByRole && !loginSelectionAllowed) || readOnly || loading;
  const disableAccessTypeSelection = Boolean(readOnly || loading);
  const loginOptions = useMemo(() => Array.from(new Set([...allLogins, ...form.logins])), [allLogins, form.logins]);
  const organismOptions = useMemo(
    () => (restrictedByRole ? (myScope?.organism ? [myScope.organism] : []) : organisms),
    [restrictedByRole, myScope, organisms],
  );
  const aorOptions = useMemo(
    () => (restrictedByRole ? myScope?.aors ?? [] : aors),
    [restrictedByRole, myScope, aors],
  );
  const selectedOrganisms = useMemo(
    () => organismOptions.filter((option) => form.organismIds.includes(option.id)),
    [organismOptions, form.organismIds],
  );
  const selectedAors = useMemo(
    () => aorOptions.filter((option) => form.aorIds.includes(option.id)),
    [aorOptions, form.aorIds],
  );

  return (
    <Stack spacing={1.5}>
      <FormControl>
        <FormLabel>Тип доступу</FormLabel>
        <RadioGroup
          row
          value={form.accessType}
          onChange={(event) => {
            if (disableAccessTypeSelection) return;
            const nextType = event.target.value as AccessType;
            onChange(applyRestrictedAccess(withDefaultOrganismAccess(form, nextType, myScope), user, myScope, allLogins));
          }}
        >
          {availableAccessTypes.map((accessType) => (
            <FormControlLabel
              key={accessType}
              value={accessType}
              control={<Radio size="small" />}
              label={accessTypeLabel(accessType)}
              disabled={disableAccessTypeSelection}
            />
          ))}
        </RadioGroup>
      </FormControl>

      {form.accessType === 'logins' ? (
        <Autocomplete
          multiple
          size="small"
          options={loginOptions}
          value={form.logins}
          onChange={(_, selected) => onChange({ ...form, logins: normalizeLogins(selected) })}
          freeSolo={!restrictLogins}
          forcePopupIcon
          disabled={restrictLogins}
          loading={loading}
          renderInput={(params) => (
            <TextField
              {...params}
              label={restrictLogins && !loginSelectionAllowed ? 'Ваш логін' : 'Логіни'}
              helperText={
                loading
                  ? `Завантажуємо логіни вашого підрозділу${ELLIPSIS}`
                  : restrictLogins && !loginSelectionAllowed
                    ? 'Автоматично заповнюється вашим логіном'
                    : 'Оберіть логіни'
              }
              slotProps={{
                input: {
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {loading ? <CircularProgress color='inherit' size={16} sx={{ mr: 1 }} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                },
              }}
            />
          )}
        />
      ) : null}

      {form.accessType === 'organisms' ? (
        <Autocomplete
          multiple
          size="small"
          options={organismOptions}
          value={selectedOrganisms}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          getOptionLabel={(option) => option.name}
          onChange={(_, selected) => onChange({ ...form, organismIds: selected.map((entry) => entry.id) })}
          disabled={restricted}
          renderOption={(props, option) => {
            const { key: _unusedKey, ...optionProps } = props;
            return (
              <li {...optionProps} key={option.id}>
                {option.name}
              </li>
            );
          }}
          renderTags={(value, getTagProps) =>
            value.map((option, index) => (
              <Chip {...getTagProps({ index })} key={option.id} label={option.name} size="small" />
            ))
          }
          renderInput={(params) => (
            <TextField
              {...params}
              label="Підрозділи"
              helperText={restricted ? 'Доступ до вашого підрозділу' : 'Оберіть підрозділи'}
            />
          )}
        />
      ) : null}

      {form.accessType === 'aor' ? (
        <Autocomplete
          multiple
          size="small"
          options={aorOptions}
          value={selectedAors}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          getOptionLabel={(option) => option.name}
          onChange={(_, selected) => onChange({ ...form, aorIds: selected.map((entry) => entry.id) })}
          disabled={restricted}
          renderOption={(props, option) => {
            const { key: _unusedKey, ...optionProps } = props;
            return (
              <li {...optionProps} key={option.id}>
                {option.name}
              </li>
            );
          }}
          renderTags={(value, getTagProps) =>
            value.map((option, index) => (
              <Chip {...getTagProps({ index })} key={option.id} label={option.name} size="small" />
            ))
          }
          renderInput={(params) => (
            <TextField
              {...params}
              label="Смуги (AOR)"
              helperText={restricted ? 'Доступ до ваших смуг' : 'Оберіть смуги'}
            />
          )}
        />
      ) : null}
    </Stack>
  );
}

export const AccessEditor = memo(AccessEditorComponent);
