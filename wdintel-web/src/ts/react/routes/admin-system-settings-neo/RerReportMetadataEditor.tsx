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

import { reportParentContext } from './rer-report-hierarchy';

type UnitOption = { id: number; name: string; reportParentContext?: string };
export type EditorState = {
  id: number | null;
  unit: UnitOption | null;
  locations: string[];
  reportName: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

function normalizeValues(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function nameForUnit(state: EditorState, unit: UnitOption | null): string {
  if (state.id !== null) return state.reportName;
  return !state.reportName || state.reportName === state.unit?.name
    ? (unit?.name ?? '')
    : state.reportName;
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
        const options: UnitOption[] = units
          .filter((unit) => !usedUnitIds.has(unit.id))
          .map((unit) => ({
            id: unit.id,
            name: unit.name,
            reportParentContext: reportParentContext(unit),
          }));
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

  const reportName = state?.reportName.trim() ?? '';
  const hierarchyError =
    state?.unit?.reportParentContext &&
    state.unit.reportParentContext !== '[]' &&
    rows.some(
      (row) =>
        !row.sigintUnitDeleted &&
        row.reportParentContext !== '[]' &&
        row.id !== state.id &&
        row.reportName === reportName &&
        row.reportParentContext !== state.unit?.reportParentContext,
    )
      ? `Назва для звіту «${reportName}» вже використовується підрозділом з іншою ієрархією. Оберіть іншу назву.`
      : null;
  const shownError = error ?? hierarchyError;

  return (
    <Dialog open={state !== null} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {state?.id === null ? 'Додати метадані РЕР' : 'Редагувати метадані РЕР'}
      </DialogTitle>
      <DialogContent>
        {state ? (
          <div className="flex flex-col gap-echo-lg pt-echo-sm">
            {shownError ? <PowerAlert severity="error">{shownError}</PowerAlert> : null}
            <Autocomplete<UnitOption>
              options={unitOptions}
              disabled={saving}
              value={state.unit}
              inputValue={unitInput}
              loading={unitLoading}
              filterOptions={(options) => options}
              getOptionLabel={(option) => option.name}
              getOptionKey={(option) => option.id}
              renderOption={({ key, ...props }, option) => (
                <li key={key} {...props}>
                  {option.name}
                  {unitOptions.some((other) => other.id !== option.id && other.name === option.name)
                    ? ` (#${option.id})`
                    : ''}
                </li>
              )}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              onInputChange={(_, value) => {
                setUnitInput(value);
              }}
              onChange={(_, unit) =>
                onChange({
                  ...state,
                  unit,
                  reportName: nameForUnit(state, unit),
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
                  label="Райони розташування"
                  helperText="Введіть район і натисніть Enter"
                />
              )}
            />
            <TextField
              disabled={saving}
              required
              label="Назва для звіту"
              value={state.reportName}
              onChange={(event) => onChange({ ...state, reportName: event.target.value })}
              helperText="Однакова назва об’єднує повідомлення підрозділів в один розділ звіту"
            />
          </div>
        ) : null}
      </DialogContent>
      <DialogActions>
        <PowerButton variant="outlined" onClick={onClose} disabled={saving}>
          Скасувати
        </PowerButton>
        <PowerButton
          variant="contained"
          onClick={onSave}
          disabled={
            saving ||
            !state?.unit ||
            !reportName ||
            /[\r\n]/.test(reportName) ||
            Boolean(hierarchyError)
          }
        >
          {saving ? 'Збереження…' : 'Зберегти'}
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}
