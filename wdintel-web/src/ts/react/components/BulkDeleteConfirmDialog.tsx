import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  List,
  ListItem,
  ListItemText,
} from '@mui/material';
import type { ReactNode } from 'react';

export type BulkDeleteDialogItem = {
  id: string | number;
  primary: ReactNode;
  secondary?: ReactNode;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onExited?: () => void;
  summaryText: string;
  items: BulkDeleteDialogItem[];
  submitting: boolean;
  disabled?: boolean;
  /** Disables only confirmation, keeping «Скасувати» available. */
  confirmDisabled?: boolean;
  title?: string;
  confirmLabel?: string;
  /** Extra content after the item list, such as options or an error. */
  children?: ReactNode;
};

export function BulkDeleteConfirmDialog({
  open,
  onClose,
  onConfirm,
  onExited,
  summaryText,
  items,
  submitting,
  disabled = false,
  confirmDisabled = false,
  title = 'Підтвердження видалення',
  confirmLabel = 'Видалити',
  children,
}: Props) {
  const blocked = submitting || disabled;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      disableRestoreFocus
      TransitionProps={onExited ? { onExited } : undefined}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers sx={{ maxHeight: 420 }}>
        <DialogContentText sx={{ mb: 2 }}>{summaryText}</DialogContentText>
        <List dense disablePadding sx={{ maxHeight: 260, overflowY: 'auto' }}>
          {items.map((item) => (
            <ListItem key={item.id} disableGutters sx={{ py: 0.25 }}>
              <ListItemText primary={item.primary} secondary={item.secondary} />
            </ListItem>
          ))}
        </List>
        {children}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={blocked}>
          Скасувати
        </Button>
        <Button
          onClick={onConfirm}
          color="error"
          variant="contained"
          disabled={blocked || confirmDisabled}
          startIcon={submitting ? <CircularProgress color="inherit" size={16} /> : null}
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
