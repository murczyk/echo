import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  TextField,
} from '@mui/material';
import { useEffect, useMemo, useRef, useState } from 'react';

import { PowerButton } from './PowerButton';

type Props = {
  open: boolean;
  fileName: string;
  onClose: () => void;
  onRename: (fileName: string) => Promise<void> | void;
};

function splitName(fileName: string) {
  const index = fileName.lastIndexOf('.');
  return index > 0 ? [fileName.slice(0, index), fileName.slice(index)] : [fileName, ''];
}

export function AttachmentRenameDialog({ open, fileName, onClose, onRename }: Props) {
  const [baseName, extension] = useMemo(() => splitName(fileName), [fileName]);
  const [value, setValue] = useState(baseName);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setValue(baseName);
      setError('');
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [baseName, open]);
  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed) return setError('Назва файлу не може бути порожньою.');
    if (/[<>:"/\\|?*\x00-\x1F]/.test(trimmed))
      return setError('Назва файлу містить неприпустимі символи.');
    setSaving(true);
    try {
      await onRename(`${trimmed}${extension}`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не вдалося перейменувати файл.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      disableRestoreFocus
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle>Перейменувати файл</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          inputRef={inputRef}
          fullWidth
          margin="dense"
          label="Назва файлу"
          value={value}
          error={Boolean(error)}
          helperText={error}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          InputProps={
            extension
              ? { endAdornment: <InputAdornment position="end">{extension}</InputAdornment> }
              : undefined
          }
        />
      </DialogContent>
      <DialogActions>
        <PowerButton onClick={onClose} disabled={saving}>
          Скасувати
        </PowerButton>
        <PowerButton variant="contained" onClick={() => void submit()} disabled={saving}>
          Перейменувати
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}
