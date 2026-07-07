import AddIcon from '@mui/icons-material/Add';
import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from '@mui/material';
import { useEffect, useState } from 'react';

import { PowerAlert } from '../../../components/PowerAlert';
import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import { DeviceFileRowsEditor } from '../../devices/components/DeviceFileRowsEditor';
import {
  validateDeviceFileRows,
  type DeviceFileDraft,
  type DeviceFileDraftError,
  type DeviceServerFieldErrors,
} from '../../devices/device-form';

type Props = {
  open: boolean;
  rows: DeviceFileDraft[];
  error: string | null;
  serverFieldErrors: DeviceServerFieldErrors;
  submitting: boolean;
  onRowsChange: (rows: DeviceFileDraft[]) => void;
  onClose: () => void;
  onSubmit: (rows: DeviceFileDraft[]) => void;
};

const EMPTY_ROW_ERRORS: Record<string, DeviceFileDraftError> = {};

export function DeviceFileBatchCreateDialog({
  open,
  rows,
  error,
  serverFieldErrors,
  submitting,
  onRowsChange,
  onClose,
  onSubmit,
}: Props) {
  const [submitted, setSubmitted] = useState(false);
  const validation = validateDeviceFileRows(rows, { rejectEmpty: true });
  const hasErrors = validation.files !== undefined || Object.keys(validation.fileRows).length > 0;

  useEffect(() => {
    if (open) setSubmitted(false);
  }, [open]);

  const handleSubmit = () => {
    setSubmitted(true);
    if (hasErrors) return;
    onSubmit(rows);
  };

  const rowErrors = submitted ? validation.fileRows : EMPTY_ROW_ERRORS;

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle>Додати файли</DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
        {serverFieldErrors.files ? (
          <PowerAlert severity="error">{serverFieldErrors.files}</PowerAlert>
        ) : null}
        {submitted && validation.files ? (
          <PowerAlert severity="error">{validation.files}</PowerAlert>
        ) : null}
        <DeviceFileRowsEditor
          rows={rows}
          errors={rowErrors}
          disabled={submitting}
          title="Файли"
          emptyText="Додайте принаймні один файл."
          onChange={onRowsChange}
        />
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
        <Button onClick={onClose} disabled={submitting}>
          Скасувати
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={submitting}
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : <AddIcon />}
        >
          {submitting ? 'Додавання…' : 'Додати файли'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
