import { Alert, Dialog, DialogActions, DialogContent, DialogTitle, TextField } from '@mui/material';

import { PowerButton } from '../../../components/PowerButton';

type Props = {
  open: boolean;
  name: string;
  error: string | null;
  submitting: boolean;
  onNameChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function CreateDeviceDialog({
  open,
  name,
  error,
  submitting,
  onNameChange,
  onClose,
  onSubmit,
}: Props) {
  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Створити пристрій</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2 }}>
        {error ? <Alert severity="error">{error}</Alert> : null}
        <TextField
          autoFocus
          label="Назва"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSubmit();
            }
          }}
          required
          fullWidth
          disabled={submitting}
          helperText="Додаткові поля, AOR, підрозділ і файли будуть доступні у розширеній формі."
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <PowerButton onClick={onClose} disabled={submitting}>
          Скасувати
        </PowerButton>
        <PowerButton variant="contained" onClick={onSubmit} disabled={submitting}>
          {submitting ? 'Створення...' : 'Створити'}
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}
