import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';

import { PowerButton } from '../../../components/PowerButton';

export function ImageEditorDiscardAlert({
  onContinue,
  onDiscard,
}: {
  onContinue: () => void;
  onDiscard: () => void;
}) {
  return (
    <Dialog open onClose={onContinue} fullWidth maxWidth="xs">
      <DialogTitle>Відкинути зміни зображення?</DialogTitle>
      <DialogContent>
        <DialogContentText>
          Незбережені зміни буде втрачено. Початкове зображення залишиться без змін.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <PowerButton type="button" autoFocus onClick={onContinue}>
          Продовжити редагування
        </PowerButton>
        <PowerButton type="button" color="error" variant="contained" onClick={onDiscard}>
          Відкинути зміни
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}
