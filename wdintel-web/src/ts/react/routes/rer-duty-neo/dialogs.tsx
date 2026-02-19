import { Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material';
import React from 'react';

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
      <DialogActions>
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
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>Коментар</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={4}
          placeholder="Введіть коментар..."
          value={commentText}
          onChange={(e) => onCommentTextChange(e.target.value)}
          className="mt-2 min-w-[300px]"
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Відміна</Button>
        <Button variant="contained" onClick={onSave}>
          Зберегти
        </Button>
      </DialogActions>
    </Dialog>
  );
}
