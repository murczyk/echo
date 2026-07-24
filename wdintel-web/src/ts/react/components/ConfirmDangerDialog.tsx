import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';
import type { ReactNode } from 'react';

type Props = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onExited?: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  cancelLabel?: ReactNode;
  confirmLabel?: ReactNode;
  submitting?: boolean;
  disabled?: boolean;
  maxWidth?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  fullWidth?: boolean;
  disableRestoreFocus?: boolean;
};

export function ConfirmDangerDialog({
  open,
  onClose,
  onConfirm,
  onExited,
  title = 'Підтвердження видалення',
  description,
  children,
  cancelLabel = 'Скасувати',
  confirmLabel = 'Видалити',
  submitting = false,
  disabled = false,
  maxWidth = 'sm',
  fullWidth = true,
  disableRestoreFocus = false,
}: Props) {
  const blocked = submitting || disabled;

  return (
    <Dialog
      open={open}
      onClose={blocked ? undefined : onClose}
      TransitionProps={onExited ? { onExited } : undefined}
      fullWidth={fullWidth}
      maxWidth={maxWidth}
      disableRestoreFocus={disableRestoreFocus}
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {description ? <DialogContentText>{description}</DialogContentText> : null}
        {children ? (
          <div className={description ? 'mt-3 space-y-3' : 'space-y-3'}>{children}</div>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={blocked}>
          {cancelLabel}
        </Button>
        <Button
          onClick={onConfirm}
          color="error"
          variant="contained"
          disabled={blocked}
          startIcon={submitting ? <CircularProgress color="inherit" size={16} /> : null}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
