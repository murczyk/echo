import { CircularProgress } from '@mui/material';

import { PowerButton } from '../../../components/PowerButton';

export function ImageEditorFooter({
  applying,
  disabled,
  cropActive,
  ready,
  onCancel,
  onApply,
}: {
  applying: boolean;
  disabled: boolean;
  cropActive: boolean;
  ready: boolean;
  onCancel: () => void;
  onApply: () => void;
}) {
  return (
    <footer className="flex items-center justify-end gap-2 border-t border-echo-border p-2">
      <PowerButton type="button" onClick={onCancel} disabled={disabled}>
        Скасувати
      </PowerButton>
      <PowerButton
        variant="contained"
        type="button"
        onClick={onApply}
        disabled={!ready || disabled || cropActive}
      >
        {applying ? <CircularProgress size={18} color="inherit" /> : 'Застосувати'}
      </PowerButton>
    </footer>
  );
}
