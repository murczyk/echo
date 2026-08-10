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
import { STANDARD_DIALOG_ACTIONS_SX } from '../../../components/dialogStyles';
import { DEFAULT_LIST_UNITS_REQ, getUnitsPage } from '../../../services/api/units';
import { formatUnitError } from '../helpers';

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
  submitting,
  error,
  onClose,
  onConfirm,
}: {
  original: Unit | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (duplicate: Unit) => void;
}) {
  const [duplicate, setDuplicate] = useState<Unit | null>(null);
  const [options, setOptions] = useState<Unit[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  useEffect(() => {
    if (original !== null) {
      setDuplicate(null);
      setInputValue('');
    }
  }, [original]);

  useEffect(() => {
    if (original === null) return;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => {
        setLoadingOptions(true);
        setOptionsError(null);
        void getUnitsPage(
          {
            ...DEFAULT_LIST_UNITS_REQ,
            sortBy: 'UnitNameAsc',
            includeInactive: true,
            filterText: inputValue.trim() || null,
            searchMode: 'Strict',
            limit: 50,
            offset: 0,
          },
          { signal: controller.signal },
        )
          .then((response) => {
            if (!controller.signal.aborted) {
              setOptions(response.units.filter((unit) => unit.id !== original.id));
            }
          })
          .catch((requestError) => {
            if (!controller.signal.aborted) setOptionsError(formatUnitError(requestError));
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoadingOptions(false);
          });
      },
      inputValue.trim() ? 300 : 0,
    );

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [inputValue, original]);

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
            options={options}
            value={duplicate}
            onChange={(_, value) => setDuplicate(value)}
            inputValue={inputValue}
            onInputChange={(_, value) => setInputValue(value)}
            getOptionLabel={(unit) => unit.name || `#${unit.id}`}
            isOptionEqualToValue={(left, right) => left.id === right.id}
            disabled={submitting}
            loading={loadingOptions}
            loadingText="Пошук підрозділів…"
            noOptionsText="Підрозділів не знайдено"
            renderInput={(params) => <TextField {...params} label="Підрозділ-дублікат" required />}
          />
          {optionsError ? (
            <PowerAlert severity="error">Не вдалося знайти підрозділи: {optionsError}</PowerAlert>
          ) : null}
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={STANDARD_DIALOG_ACTIONS_SX}>
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
