import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
} from 'react';
import type { Callsign, Unit } from '../../../../../Bindings';
import {
  buildDuplicateHintGroups,
  createEmptyDraftRow,
  createUnitsById,
  normalizeDuplicateLookupValue,
  parseTabDelimitedInput,
  QUICK_PASTE_TSV_FORMAT_ERROR,
} from '../helpers';
import type { CallsignCreateDraft, CallsignDraftRow } from '../types';
import { CreateCallsignsDrawer } from './CreateCallsignsDrawer';

type Props = Pick<
  ComponentProps<typeof CreateCallsignsDrawer>,
  | 'open'
  | 'onClose'
  | 'units'
  | 'sources'
  | 'addUnitId'
  | 'addSourceId'
  | 'addCallsignAdditionalSourceIds'
  | 'rows'
  | 'submitting'
  | 'disabled'
  | 'validationError'
> & {
  callsigns: Callsign[];
  allUnits: Unit[];
  onSubmit: (draft: CallsignCreateDraft) => void;
};

export function CreateCallsignsDraftDrawer({
  open,
  onClose,
  units,
  sources,
  addUnitId,
  addSourceId,
  addCallsignAdditionalSourceIds,
  rows,
  submitting,
  disabled,
  validationError,
  callsigns,
  allUnits,
  onSubmit,
}: Props) {
  const [draft, setDraft] = useState<CallsignCreateDraft>({
    rows,
    unitId: addUnitId,
    sourceId: addSourceId,
    callsignAdditionalSourceIds: addCallsignAdditionalSourceIds,
  });
  const [error, setError] = useState(validationError);
  const [immediateHints, setImmediateHints] = useState(false);

  useEffect(() => {
    setDraft((prev) => ({ ...prev, rows }));
  }, [rows]);
  useEffect(() => {
    setDraft((prev) => ({ ...prev, sourceId: addSourceId }));
  }, [addSourceId]);
  useEffect(() => {
    if (open) return;
    setDraft({
      rows,
      unitId: addUnitId,
      sourceId: addSourceId,
      callsignAdditionalSourceIds: addCallsignAdditionalSourceIds,
    });
    setImmediateHints(false);
    setError(validationError);
  }, [open, rows, addUnitId, addSourceId, addCallsignAdditionalSourceIds, validationError]);
  useEffect(() => {
    setError(validationError);
  }, [validationError]);

  const hintInputs = useMemo(
    () =>
      draft.rows
        .map((row, rowIndex) => ({
          rowIndex,
          callsignInput: normalizeDuplicateLookupValue(row.callsign),
          fullNameInput: normalizeDuplicateLookupValue(row.fullName),
          positionInput: normalizeDuplicateLookupValue(row.position),
        }))
        .filter((row) => row.callsignInput.length >= 2 || row.fullNameInput.length >= 2),
    [draft.rows],
  );
  const deferredHintInputs = useDeferredValue(hintInputs);
  const unitsById = useMemo(() => createUnitsById(allUnits), [allUnits]);
  const duplicateHintGroups = useMemo(
    () =>
      submitting || hintInputs.length === 0
        ? []
        : buildDuplicateHintGroups(
            immediateHints ? hintInputs : deferredHintInputs,
            callsigns,
            draft.unitId,
            unitsById,
          ),
    [
      submitting,
      immediateHints,
      hintInputs,
      deferredHintInputs,
      callsigns,
      draft.unitId,
      unitsById,
    ],
  );

  const onRowChange = useCallback((index: number, row: CallsignDraftRow) => {
    setError(null);
    setImmediateHints(false);
    setDraft((prev) => ({
      ...prev,
      rows: prev.rows.map((current, rowIndex) => (rowIndex === index ? row : current)),
    }));
  }, []);
  const onApplyPastedRows = useCallback((value: string) => {
    setError(null);
    if (!value.includes('\t') && !value.includes('\n')) return;
    const parsed = parseTabDelimitedInput(value);
    setError(parsed.error ?? (parsed.rows.length === 0 ? QUICK_PASTE_TSV_FORMAT_ERROR : null));
    setDraft((prev) => ({
      ...prev,
      rows: parsed.rows.length > 0 ? parsed.rows : [createEmptyDraftRow()],
    }));
    setImmediateHints(parsed.rows.length > 0);
  }, []);

  return (
    <CreateCallsignsDrawer
      open={open}
      onClose={onClose}
      units={units}
      sources={sources}
      addUnitId={draft.unitId}
      addSourceId={draft.sourceId}
      addCallsignAdditionalSourceIds={draft.callsignAdditionalSourceIds}
      rows={draft.rows}
      submitting={submitting}
      disabled={disabled}
      validationError={error}
      duplicateHintGroups={duplicateHintGroups}
      onAddUnitIdChange={(unitId) => setDraft((prev) => ({ ...prev, unitId }))}
      onAddSourceIdChange={(sourceId) => setDraft((prev) => ({ ...prev, sourceId }))}
      onAddCallsignAdditionalSourceIdsChange={(callsignAdditionalSourceIds) =>
        setDraft((prev) => ({ ...prev, callsignAdditionalSourceIds }))
      }
      onRowChange={onRowChange}
      onAppendRow={() => {
        setImmediateHints(false);
        setDraft((prev) => ({ ...prev, rows: [...prev.rows, createEmptyDraftRow()] }));
      }}
      onRemoveRow={(index) => {
        setError(null);
        setImmediateHints(false);
        setDraft((prev) => ({
          ...prev,
          rows:
            prev.rows.length > 1
              ? prev.rows.filter((_, rowIndex) => rowIndex !== index)
              : prev.rows,
        }));
      }}
      onClearRows={() => {
        setError(null);
        setImmediateHints(false);
        setDraft((prev) => ({ ...prev, rows: [createEmptyDraftRow()] }));
      }}
      onApplyPastedRows={onApplyPastedRows}
      onSubmit={() => {
        setError(validationError);
        onSubmit(draft);
      }}
    />
  );
}
