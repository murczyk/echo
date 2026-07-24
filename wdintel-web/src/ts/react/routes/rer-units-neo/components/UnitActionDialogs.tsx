import {
  Autocomplete,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { Unit } from '../../../../../Bindings';
import { ConfirmDangerDialog } from '../../../components/ConfirmDangerDialog';
import { PowerAlert } from '../../../components/PowerAlert';

export function DeleteUnitDialog({
  unit,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  unit: Unit | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDangerDialog
      open={unit !== null}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Видалити підрозділ?"
      description={
        unit === null
          ? undefined
          : `Підрозділ «${unit.name}» буде видалено. Цю дію неможливо скасувати.`
      }
      submitting={submitting}
    >
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
    </ConfirmDangerDialog>
  );
}

export function MergeUnitDialog({
  original,
  units,
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  original: Unit | null;
  units: Unit[];
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (duplicate: Unit) => void;
}) {
  const [duplicate, setDuplicate] = useState<Unit | null>(null);

  useEffect(() => {
    if (original !== null) setDuplicate(null);
  }, [original]);

  return (
    <Dialog
      open={original !== null}
      onClose={submitting ? undefined : onClose}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>Об’єднати дублікати</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <PowerAlert severity="warning" autoHideDuration={null}>
            Усі позивні, сигнали, файли та прив’язки вибраного дубліката буде перенесено до
            підрозділу «{original?.name}», після чого дублікат буде видалено.
          </PowerAlert>
          <Autocomplete
            options={units.filter((unit) => unit.id !== original?.id)}
            value={duplicate}
            onChange={(_, value) => setDuplicate(value)}
            getOptionLabel={(unit) => unit.name || `#${unit.id}`}
            isOptionEqualToValue={(left, right) => left.id === right.id}
            disabled={submitting}
            renderInput={(params) => <TextField {...params} label="Підрозділ-дублікат" required />}
          />
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Скасувати
        </Button>
        <Button
          color="warning"
          variant="contained"
          onClick={() => duplicate && onConfirm(duplicate)}
          disabled={submitting || duplicate === null}
          startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : null}
        >
          Об’єднати
        </Button>
      </DialogActions>
    </Dialog>
  );
}
