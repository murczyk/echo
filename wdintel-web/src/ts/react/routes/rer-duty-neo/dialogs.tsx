import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { STANDARD_DIALOG_ACTIONS_SX, STANDARD_DIALOG_FORM_STACK_SX } from '../../components/dialogStyles';
import { ELLIPSIS } from '../../utils/misc';
import { blurActiveElement } from '../shared/message-card/message-card-focus';

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
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        <Button size={actionSize} variant={cancelVariant} onClick={onClose} disabled={confirmDisabled}>
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

type CommentDialogProps = {
  open: boolean;
  messagePreview?: CommentDialogMessagePreview | null;
  commentText: string;
  onCommentTextChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
};

export type CommentDialogMessagePreview = {
  text: string | null;
  freq: string | null;
  groupMasterKey: string | null;
  groupName?: string | null;
  sender: string | null;
  senderName?: string | null;
};

function renderCommentPreview(message: CommentDialogMessagePreview | null | undefined) {
  if (!message) return null;

  const title = [message.freq, message.groupName ?? message.groupMasterKey, message.senderName ?? message.sender]
    .filter(Boolean)
    .join(' • ');
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
      disableRestoreFocus
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
            placeholder={`Введіть коментар${ELLIPSIS}`}
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
