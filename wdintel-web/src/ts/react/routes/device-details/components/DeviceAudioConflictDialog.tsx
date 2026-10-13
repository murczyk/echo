import { Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material';
import { useEffect, useState } from 'react';
import { PowerButton } from '../../../components/PowerButton';
import type { DeviceAudioEditorState } from '../use-device-audio-editor';

export function DeviceAudioConflictDialog({ editor }: { editor: DeviceAudioEditorState }) {
  const [open, setOpen] = useState(true);
  useEffect(() => setOpen(true), [editor.conflict?.textVersion]);
  if (!editor.conflict) return null;
  return (
    <>
      <PowerButton onClick={() => setOpen(true)}>Зіставити транскрипції</PowerButton>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>Транскрипцію змінено</DialogTitle>
        <DialogContent>
          <p className="mb-echo-md">
            Порівняйте тексти. Збереження після узгодження потребує окремого натискання кнопки.
          </p>
          <div className="grid min-w-0 grid-cols-1 gap-echo-md md:grid-cols-2">
            <TextField
              label="Актуальний текст"
              multiline
              minRows={6}
              maxRows={12}
              value={editor.conflict.text}
              inputProps={{ readOnly: true }}
            />
            <TextField
              label="Моя чернетка"
              multiline
              minRows={6}
              maxRows={12}
              value={editor.draft}
              onChange={(event) => editor.setDraft(event.target.value)}
              inputProps={{ readOnly: !editor.canEdit || editor.automaticView }}
            />
          </div>
        </DialogContent>
        <DialogActions>
          <PowerButton disabled={editor.saving} onClick={() => editor.acceptCurrent(true)}>
            Використати актуальний текст
          </PowerButton>
          <PowerButton disabled={editor.saving} onClick={() => editor.acceptCurrent(false)}>
            Залишити мою чернетку
          </PowerButton>
          <PowerButton onClick={() => setOpen(false)}>Закрити</PowerButton>
        </DialogActions>
      </Dialog>
    </>
  );
}
