import {
  Autocomplete,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  TextField,
} from '@mui/material';

import { AreaOfResponsibility, MyScope, Organism, User } from '../../../../../Bindings';
import {
  accessTypeLabel,
  applyRestrictedAccess,
  isAccessRestricted,
  normalizeLogins,
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
};

export function AccessEditor({
  form,
  onChange,
  readOnly = false,
  user,
  myScope,
  organisms,
  aors,
  allLogins,
  availableAccessTypes,
}: Props) {
  const restrictedByRole = isAccessRestricted(user);
  const restricted = restrictedByRole || readOnly;
  const loginOptions = Array.from(new Set([...allLogins, ...form.logins]));
  const organismOptions = restrictedByRole ? (myScope?.organism ? [myScope.organism] : []) : organisms;
  const aorOptions = restrictedByRole ? myScope?.aors ?? [] : aors;

  return (
    <Stack spacing={1.5}>
      <FormControl>
        <FormLabel>Тип доступу</FormLabel>
        <RadioGroup
          row
          value={form.accessType}
          onChange={(event) => {
            const nextType = event.target.value as AccessType;
            onChange(applyRestrictedAccess({ ...form, accessType: nextType }, user, myScope));
          }}
        >
          {availableAccessTypes.map((accessType) => (
            <FormControlLabel
              key={accessType}
              value={accessType}
              control={<Radio size="small" />}
              label={accessTypeLabel(accessType)}
              disabled={readOnly}
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
          freeSolo={!restricted}
          forcePopupIcon
          disabled={restricted}
          renderInput={(params) => (
            <TextField
              {...params}
              label={restricted ? 'Ваш логін' : 'Логіни'}
              helperText={restricted ? 'Автоматично заповнюється вашим логіном' : 'Оберіть логіни'}
            />
          )}
        />
      ) : null}

      {form.accessType === 'organisms' ? (
        <Autocomplete
          multiple
          size="small"
          options={organismOptions}
          value={organismOptions.filter((option) => form.organismIds.includes(option.id))}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          getOptionLabel={(option) => option.name}
          onChange={(_, selected) => onChange({ ...form, organismIds: selected.map((entry) => entry.id) })}
          disabled={restricted}
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
          value={aorOptions.filter((option) => form.aorIds.includes(option.id))}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          getOptionLabel={(option) => option.name}
          onChange={(_, selected) => onChange({ ...form, aorIds: selected.map((entry) => entry.id) })}
          disabled={readOnly}
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
