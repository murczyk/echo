import { Box, Button, CircularProgress, Drawer, Typography } from '@mui/material';
import { memo } from 'react';

import { AreaOfResponsibility, MyScope, Organism, User } from '../../../../../Bindings';
import { applyRestrictedAccess, isFormValid } from '../helpers';
import { AccessType, PalitraFormState } from '../types';
import { PalitraFormFields } from './PalitraFormFields';

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
  referenceDataReady: boolean;
  onSetEditForm: (updater: (prev: PalitraFormState | null) => PalitraFormState | null) => void;
  onSave: () => void;
  disableRestoreFocus?: boolean;
};

function EditPalitraDrawerComponent({
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
  referenceDataReady,
  onSetEditForm,
  onSave,
  disableRestoreFocus = false,
}: Props) {
  const formBlocked = editInFlight || !referenceDataReady;

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={editInFlight ? undefined : onClose}
      ModalProps={{ disableRestoreFocus }}
      slotProps={{
        paper: { sx: { width: { xs: '100%', sm: 560 }, maxWidth: '100vw', display: 'flex' } },
      }}
    >
      <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="h6">Редагувати палітру</Typography>
      </Box>
      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        {editForm ? (
          <PalitraFormFields
            form={editForm}
            onChange={(updater) => onSetEditForm((prev) => (prev ? updater(prev) : prev))}
            user={user}
            myScope={myScope}
            organisms={organisms}
            aors={aors}
            allLogins={allLogins}
            availableAccessTypes={availableAccessTypes}
            loading={!referenceDataReady}
            disabled={formBlocked}
          />
        ) : null}
      </Box>
      <Box
        sx={{
          p: 2.5,
          borderTop: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 2,
        }}
      >
        <Button onClick={onClose} disabled={editInFlight}>
          Скасувати
        </Button>
        <Button
          onClick={onSave}
          variant="contained"
          disabled={
            formBlocked ||
            !editForm ||
            editPalitraId === null ||
            !isFormValid(applyRestrictedAccess(editForm, user, myScope, allLogins))
          }
        >
          {editInFlight ? <CircularProgress size={16} /> : 'Зберегти'}
        </Button>
      </Box>
    </Drawer>
  );
}

export const EditPalitraDrawer = memo(EditPalitraDrawerComponent);
