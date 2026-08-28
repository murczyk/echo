import {
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  InputAdornment,
  TextField,
} from '@mui/material';

import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { ImageEditorSaveDialog } from './image-editor.types';

type SaveDialog = ImageEditorSaveDialog | null;

export function ImageEditorSaveDialogs({
  activeDialog,
  basename,
  disabled,
  extension,
  filenameError,
  onBasenameChange,
  onClose,
  onExited,
  onSaveAsNew,
  onSaveReplacement,
  saveError,
}: {
  activeDialog: SaveDialog;
  basename: string;
  disabled: boolean;
  extension: string;
  filenameError: string | null;
  onBasenameChange: (value: string) => void;
  onClose: (dialog: ImageEditorSaveDialog) => void;
  onExited: () => void;
  onSaveAsNew: () => void;
  onSaveReplacement: () => void;
  saveError: string | null;
}) {
  const dialogProps = {
    disableRestoreFocus: true,
    fullWidth: true,
    maxWidth: 'xs' as const,
    onClose: () => {
      if (!disabled && activeDialog) onClose(activeDialog);
    },
    slotProps: { transition: { onExited } },
  };
  return (
    <>
      <Dialog {...dialogProps} open={activeDialog === ImageEditorSaveDialog.Replacement}>
        <DialogTitle>Замінити поточне зображення?</DialogTitle>
        <DialogContent sx={{ pb: 0 }}>
          <DialogContentText>
            Відредаговане зображення замінить поточне вкладення.
          </DialogContentText>
          {saveError ? (
            <PowerAlert severity="error" autoHideDuration={null} dismissible={false}>
              {saveError}
            </PowerAlert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <PowerButton
            type="button"
            autoFocus
            disabled={disabled}
            onClick={() => onClose(ImageEditorSaveDialog.Replacement)}
          >
            Скасувати
          </PowerButton>
          <PowerButton
            variant="contained"
            type="button"
            disabled={disabled}
            onClick={onSaveReplacement}
          >
            {disabled ? <CircularProgress size={18} color="inherit" /> : 'Замінити'}
          </PowerButton>
        </DialogActions>
      </Dialog>
      <Dialog {...dialogProps} open={activeDialog === ImageEditorSaveDialog.New}>
        <DialogTitle>Зберегти як нове зображення</DialogTitle>
        <DialogContent sx={{ pt: 2.5, overflow: 'visible' }}>
          <TextField
            autoFocus
            fullWidth
            label="Назва файлу"
            value={basename}
            error={Boolean(filenameError)}
            helperText={filenameError}
            disabled={disabled}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => onBasenameChange(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                onSaveAsNew();
              }
            }}
            slotProps={{
              inputLabel: { shrink: true },
              input: {
                endAdornment: <InputAdornment position="end">.{extension}</InputAdornment>,
              },
            }}
          />
          {saveError ? (
            <PowerAlert severity="error" autoHideDuration={null} dismissible={false}>
              {saveError}
            </PowerAlert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <PowerButton
            type="button"
            disabled={disabled}
            onClick={() => onClose(ImageEditorSaveDialog.New)}
          >
            Скасувати
          </PowerButton>
          <PowerButton variant="contained" type="button" disabled={disabled} onClick={onSaveAsNew}>
            {disabled ? <CircularProgress size={18} color="inherit" /> : 'Зберегти як новий'}
          </PowerButton>
        </DialogActions>
      </Dialog>
    </>
  );
}
