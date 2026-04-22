import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import type { InboxMessage } from '../../../../Bindings';
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
  messagePreview?: InboxMessage | null;
  commentText: string;
  onCommentTextChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
};

function renderCommentPreview(message: InboxMessage | null | undefined) {
  if (!message) return null;

  const title = [message.freq, message.groupMasterKey, message.sender].filter(Boolean).join(' • ');
  const text = (message.text ?? '').trim();

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        px: 1.5,
        py: 1,
        bgcolor: 'action.hover',
        minWidth: 0,
      }}
    >
      <Stack spacing={0.5} sx={{ minWidth: 0 }}>
        {title !== '' ? (
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, letterSpacing: 0.2 }}>
            {title}
          </Typography>
        ) : null}
        {text !== '' ? (
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto' }}>
            {text}
          </Typography>
        ) : null}
      </Stack>
    </Box>
  );
}

export function CommentDialog({ open, messagePreview, commentText, onCommentTextChange, onClose, onSave }: CommentDialogProps) {
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
          {renderCommentPreview(messagePreview)}
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
