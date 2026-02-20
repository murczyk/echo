import { Box, Button, CircularProgress, Drawer, Stack, TextField, Typography } from '@mui/material';

import { AreaOfResponsibility, MyScope, Organism, User } from '../../../../../Bindings';
import { applyRestrictedAccess, isFormValid } from '../helpers';
import { AccessType, PalitraFormState } from '../types';
import { AccessEditor } from './AccessEditor';

type Props = {
  open: boolean;
  onClose: () => void;
  editInFlight: boolean;
  editPalitraId: number | null;
  editForm: PalitraFormState | null;
  user: User | null;
  myScope: MyScope | null;
  organisms: Organism[];
  aors: AreaOfResponsibility[];
  allLogins: string[];
  availableAccessTypes: AccessType[];
  onSetEditForm: (updater: (prev: PalitraFormState | null) => PalitraFormState | null) => void;
  onSave: () => void;
};

export function EditPalitraDrawer({
  open,
  onClose,
  editInFlight,
  editPalitraId,
  editForm,
  user,
  myScope,
  organisms,
  aors,
  allLogins,
  availableAccessTypes,
  onSetEditForm,
  onSave,
}: Props) {
  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={editInFlight ? undefined : onClose}
      sx={{
        zIndex: 3500,
        '& .MuiBackdrop-root': { zIndex: 3499 },
        '& .MuiDrawer-paper': { zIndex: 3500 },
      }}
      PaperProps={{ sx: { width: { xs: '100%', sm: 560 }, maxWidth: '100vw', display: 'flex' } }}
    >
      <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="h6">Редагувати палітру</Typography>
      </Box>
      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        {editForm ? (
          <Stack spacing={2}>
            <TextField
              label="Назва"
              size="small"
              value={editForm.name}
              onChange={(event) => onSetEditForm((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
              disabled={editInFlight}
              fullWidth
            />

            <TextField
              label="Колір"
              type="color"
              size="small"
              value={editForm.colorHex}
              onChange={(event) => onSetEditForm((prev) => (prev ? { ...prev, colorHex: event.target.value } : prev))}
              disabled={editInFlight}
              sx={{ width: '140px' }}
            />

            <AccessEditor
              form={editForm}
              onChange={(next) => onSetEditForm(() => next)}
              user={user}
              myScope={myScope}
              organisms={organisms}
              aors={aors}
              allLogins={allLogins}
              availableAccessTypes={availableAccessTypes}
            />
          </Stack>
        ) : null}
      </Box>
      <Box sx={{ p: 2.5, borderTop: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
        <Button onClick={onClose} disabled={editInFlight}>
          Скасувати
        </Button>
        <Button
          onClick={onSave}
          variant="contained"
          disabled={
            editInFlight ||
            !editForm ||
            editPalitraId === null ||
            !isFormValid(applyRestrictedAccess(editForm, user, myScope))
          }
        >
          {editInFlight ? <CircularProgress size={16} /> : 'Зберегти'}
        </Button>
      </Box>
    </Drawer>
  );
}
