import { CircularProgress } from '@mui/material';
import type { Ref } from 'react';

import { PowerButton } from '../../../components/PowerButton';

export function ImageEditorFooter({
  saving,
  disabled,
  cropActive,
  ready,
  onCancel,
  onSaveReplacement,
  onSaveAsNew,
  saveAsNewButtonRef,
  saveReplacementButtonRef,
}: {
  saving: boolean;
  disabled: boolean;
  cropActive: boolean;
  ready: boolean;
  onCancel: () => void;
  onSaveReplacement: () => void;
  onSaveAsNew: () => void;
  saveAsNewButtonRef: Ref<HTMLButtonElement>;
  saveReplacementButtonRef: Ref<HTMLButtonElement>;
}) {
  return (
    <footer className="flex items-center justify-end gap-2 border-t border-echo-border p-2">
      <PowerButton type="button" onClick={onCancel} disabled={disabled}>
        Скасувати
      </PowerButton>
      <PowerButton
        ref={saveAsNewButtonRef}
        type="button"
        variant="outlined"
        onClick={onSaveAsNew}
        disabled={!ready || disabled || cropActive}
      >
        Зберегти як новий
      </PowerButton>
      <PowerButton
        ref={saveReplacementButtonRef}
        variant="contained"
        type="button"
        onClick={onSaveReplacement}
        disabled={!ready || disabled || cropActive}
      >
        {saving ? <CircularProgress size={18} color="inherit" /> : 'Зберегти'}
      </PowerButton>
    </footer>
  );
}
