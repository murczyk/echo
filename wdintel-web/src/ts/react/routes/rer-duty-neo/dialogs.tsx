import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField } from '@mui/material';
import { STANDARD_DIALOG_ACTIONS_SX, STANDARD_DIALOG_FORM_STACK_SX } from '../../components/dialogStyles';

function blurActiveElement() {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement) {
    activeElement.blur();
  }
}

type DeleteConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function DeleteConfirmDialog({ open, onClose, onConfirm }: DeleteConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>Видалити повідомлення?</DialogTitle>
      <DialogContent>Цю дію не можна скасувати.</DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        <Button onClick={onClose}>Скасувати</Button>
        <Button color="error" variant="contained" onClick={onConfirm}>
          Видалити
        </Button>
      </DialogActions>
    </Dialog>
  );
}

type CommentDialogProps = {
  open: boolean;
  commentText: string;
  onCommentTextChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
};

export function CommentDialog({ open, commentText, onCommentTextChange, onClose, onSave }: CommentDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={() => {
        blurActiveElement();
        onClose();
      }}
      fullWidth
      maxWidth="md"
    >
      <DialogTitle>Коментар</DialogTitle>
      <DialogContent>
        <Stack sx={STANDARD_DIALOG_FORM_STACK_SX}>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={4}
            placeholder="Введіть коментар..."
            value={commentText}
            onChange={(e) => onCommentTextChange(e.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        <Button
          onClick={() => {
            blurActiveElement();
            onClose();
          }}
        >
          Скасувати
        </Button>
        <Button
          variant="contained"
          onClick={() => {
            blurActiveElement();
            onSave();
          }}
        >
          Зберегти
        </Button>
      </DialogActions>
    </Dialog>
  );
}
