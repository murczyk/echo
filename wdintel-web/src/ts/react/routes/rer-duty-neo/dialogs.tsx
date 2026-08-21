import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import type { ReactNode } from 'react';

type DeleteConfirmDialogProps = {
  open: boolean;
  title?: string;
  content?: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
  confirmDisabled?: boolean;
  /** When set, both action buttons use this size (for example compact panel dialogs). */
  actionSize?: 'small' | 'medium';
  cancelVariant?: 'text' | 'outlined';
};

export function DeleteConfirmDialog({
  open,
  title = 'Видалити повідомлення?',
  content = 'Цю дію не можна скасувати.',
  onClose,
  onConfirm,
  confirmDisabled = false,
  actionSize,
  cancelVariant = 'text',
}: DeleteConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={confirmDisabled ? undefined : onClose} disableRestoreFocus>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>{content}</DialogContent>
      <DialogActions>
        <Button
          size={actionSize}
          variant={cancelVariant}
          onClick={onClose}
          disabled={confirmDisabled}
        >
          Скасувати
        </Button>
        <Button
          size={actionSize}
          color="error"
          variant="contained"
          onClick={onConfirm}
          disabled={confirmDisabled}
        >
          Видалити
        </Button>
      </DialogActions>
    </Dialog>
  );
}
