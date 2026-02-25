import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';

import type { Callsign } from '../../../../../Bindings';

type Props = {
  target: Callsign | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteCallsignDialog({ target, submitting, onCancel, onConfirm }: Props) {
  const titleId = 'callsigns-delete-dialog-title';
  const descriptionId = 'callsigns-delete-dialog-description';

  return (
    <Dialog
      open={target !== null}
      onClose={submitting ? undefined : onCancel}
      fullWidth
      maxWidth="xs"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <DialogTitle id={titleId}>Підтвердження видалення</DialogTitle>
      <DialogContent>
        <DialogContentText id={descriptionId}>
          {target ? `Видалити позивний "${target.callsign}"?` : ''}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={submitting}>
          Скасувати
        </Button>
        <Button onClick={onConfirm} color="error" variant="contained" disabled={submitting || !target}>
          {submitting ? 'Видалення…' : 'Видалити'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
