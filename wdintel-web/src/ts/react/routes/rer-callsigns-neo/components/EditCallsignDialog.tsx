import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack } from '@mui/material';

import type { Source, Unit } from '../../../../../Bindings';
import { CallsignFormFields } from './CallsignFormFields';
import type { CallsignEditForm } from '../types';

type Props = {
  open: boolean;
  form: CallsignEditForm | null;
  units: Unit[];
  sources: Source[];
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onChange: (next: CallsignEditForm) => void;
  onSave: () => void;
};

export function EditCallsignDialog({ open, form, units, sources, submitting, error, onClose, onChange, onSave }: Props) {
  const titleId = 'callsigns-edit-dialog-title';

  return (
    <Dialog
      open={open}
      onClose={submitting ? undefined : onClose}
      disableRestoreFocus
      fullWidth
      maxWidth="md"
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>Редагувати позивний</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {form ? (
            <CallsignFormFields
              value={form}
              onChange={onChange}
              units={units}
              sources={sources}
              includeUnitSelect
              includeSourceSelect
              includeConfirmationSources
              confirmationSourceIds={form.confirmationSourceIds}
              onConfirmationSourceIdsChange={(confirmationSourceIds) => onChange({ ...form, confirmationSourceIds })}
              disabled={submitting}
            />
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={submitting}>
          Скасувати
        </Button>
        <Button onClick={onSave} variant="contained" disabled={submitting || !form}>
          {submitting ? 'Збереження…' : 'Зберегти'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
