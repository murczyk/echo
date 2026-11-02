import {
  Autocomplete,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
} from '@mui/material';
import { useEffect, useState } from 'react';

import type { RerReportMetadataItem } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { isAbortError } from '../../services/api/client';
import { DEFAULT_LIST_UNITS_REQ, searchUnitsStrictThenRelaxed } from '../../services/api/units';

type UnitOption = { id: number; name: string };
export type EditorState = {
  id: number | null;
  unit: UnitOption | null;
  locations: string[];
  labels: string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function normalizeValues(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function labelsForUnit(state: EditorState, unit: UnitOption | null): string[] {
  if (state.id !== null) return state.labels;
  if (state.labels.length === 0 || state.unit === null) {
    return normalizeValues([...(unit ? [unit.name] : []), ...state.labels]);
  }
  return normalizeValues(
    state.labels.flatMap((label) =>
      label === state.unit?.name ? (unit ? [unit.name] : []) : [label],
    ),
  );
}

export function MetadataEditor({
  state,
  rows,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  state: EditorState | null;
  rows: RerReportMetadataItem[];
  saving: boolean;
  error: string | null;
  onChange: (state: EditorState) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { notify } = usePowerSnackbar();
  const [unitInput, setUnitInput] = useState('');
  const [unitOptions, setUnitOptions] = useState<UnitOption[]>([]);
  const [unitLoading, setUnitLoading] = useState(false);

  useEffect(() => {
    if (!state) {
      setUnitOptions([]);
      setUnitLoading(false);
      return;
    }
    const controller = new AbortController();
    const timeoutId = window.setTimeout(async () => {
      setUnitLoading(true);
      try {
        const units = await searchUnitsStrictThenRelaxed(
          {
            ...DEFAULT_LIST_UNITS_REQ,
            filterText: unitInput.trim() || null,
            limit: 50,
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const usedUnitIds = new Set(
          rows.filter((row) => row.id !== state.id).map((row) => row.sigintUnitId),
        );
        const options = units
          .filter((unit) => !usedUnitIds.has(unit.id))
          .map((unit) => ({ id: unit.id, name: unit.name }));
        if (state.unit && !options.some((option) => option.id === state.unit?.id)) {
          options.unshift(state.unit);
        }
        setUnitOptions(options);
      } catch (nextError) {
        if (!controller.signal.aborted && !isAbortError(nextError)) {
          setUnitOptions(state.unit ? [state.unit] : []);
          notify({
            severity: 'error',
            message: `Не вдалося знайти підрозділи: ${errorMessage(nextError)}`,
          });
        }
      } finally {
        if (!controller.signal.aborted) setUnitLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [state?.id, state?.unit?.id, unitInput, rows, notify]);

  useEffect(() => {
    if (state) setUnitInput(state.unit?.name ?? '');
  }, [state?.id]);

  return (
    <Dialog open={state !== null} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {state?.id === null ? 'Додати метадані РЕР' : 'Редагувати метадані РЕР'}
      </DialogTitle>
      <DialogContent>
        {state ? (
          <div className="flex flex-col gap-echo-lg pt-echo-sm">
            {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
            <Autocomplete<UnitOption>
              options={unitOptions}
              disabled={saving}
              value={state.unit}
              inputValue={unitInput}
              loading={unitLoading}
              filterOptions={(options) => options}
              getOptionLabel={(option) => option.name}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              onInputChange={(_, value) => {
                setUnitInput(value);
              }}
              onChange={(_, unit) =>
                onChange({
                  ...state,
                  unit,
                  labels: labelsForUnit(state, unit),
                })
              }
              noOptionsText="Підрозділів не знайдено"
              loadingText="Пошук…"
              renderInput={(params) => <TextField {...params} label="Підрозділ" required />}
            />
            <Autocomplete<string, true, false, true>
              multiple
              freeSolo
              autoSelect
              disabled={saving}
              options={[]}
              value={state.locations}
              onChange={(_, values) =>
                onChange({ ...state, locations: normalizeValues(values.map(String)) })
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="locations"
                  helperText="Введіть значення та натисніть Enter"
                />
              )}
            />
            <Autocomplete<string, true, false, true>
              multiple
              freeSolo
              autoSelect
              disabled={saving}
              options={[]}
              value={state.labels}
              onChange={(_, values) =>
                onChange({ ...state, labels: normalizeValues(values.map(String)) })
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="labels"
                  helperText="Введіть значення та натисніть Enter"
                />
              )}
            />
          </div>
        ) : null}
      </DialogContent>
      <DialogActions>
        <PowerButton variant="outlined" onClick={onClose} disabled={saving}>
          Скасувати
        </PowerButton>
        <PowerButton variant="contained" onClick={onSave} disabled={saving || !state?.unit}>
          {saving ? 'Збереження…' : 'Зберегти'}
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}
