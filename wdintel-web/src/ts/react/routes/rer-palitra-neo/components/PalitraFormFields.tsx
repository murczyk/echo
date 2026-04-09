import type { ReactNode } from 'react';
import { Stack, TextField } from '@mui/material';

import { AreaOfResponsibility, MyScope, Organism, User } from '../../../../../Bindings';
import { AccessType, PalitraFormState } from '../types';
import { AccessEditor } from './AccessEditor';

type Props = {
  form: PalitraFormState;
  onChange: (updater: (prev: PalitraFormState) => PalitraFormState) => void;
  user: User | null;
  myScope: MyScope | null;
  organisms: Organism[];
  aors: AreaOfResponsibility[];
  allLogins: string[];
  availableAccessTypes: AccessType[];
  loading: boolean;
  disabled: boolean;
  colorField?: ReactNode;
};

export function PalitraFormFields({
  form,
  onChange,
  user,
  myScope,
  organisms,
  aors,
  allLogins,
  availableAccessTypes,
  loading,
  disabled,
  colorField = (
    <TextField
      label="Колір"
      type="color"
      size="small"
      value={form.colorHex}
      onChange={(event) => onChange((prev) => ({ ...prev, colorHex: event.target.value }))}
      disabled={disabled}
      sx={{ width: '140px' }}
    />
  ),
}: Props) {
  return (
    <Stack spacing={2}>
      {colorField}

      <TextField
        label="Назва"
        size="small"
        value={form.name}
        onChange={(event) => onChange((prev) => ({ ...prev, name: event.target.value }))}
        disabled={disabled}
        fullWidth
      />

      <AccessEditor
        form={form}
        onChange={(next) => onChange(() => next)}
        user={user}
        myScope={myScope}
        organisms={organisms}
        aors={aors}
        allLogins={allLogins}
        availableAccessTypes={availableAccessTypes}
        loading={loading}
      />
    </Stack>
  );
}
