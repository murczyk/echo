import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Callsign, Source } from '../../../../Bindings';
import { createCallsign } from '../../services/api/callsigns';
import { formatErrorMessage, UNIT_SELECTION_REQUIRED_ERROR } from './helpers-core';
import {
  createEmptyDraftRow,
  hasAnyDraftValue,
  makeCreatePayload,
  parseTabDelimitedInput,
  QUICK_PASTE_TSV_FORMAT_ERROR,
  validateDraftRows,
} from './helpers-form';
import { hasAnyDuplicateHintInput } from './use-rer-callsigns-neo-page.shared';
import { normalizeCallsign } from './use-rer-callsigns-neo-page.shared';
import type { CallsignDraftRow, ExportPermission, UiStatus } from './types';

type SetState<T> = Dispatch<SetStateAction<T>>;

type Args = {
  permissions: ExportPermission;
  addUnitId: number | null;
  addSourceId: number | null;
  addCallsignAdditionalSourceIds: number[];
  addRows: CallsignDraftRow[];
  addSubmitting: boolean;
  setAddDuplicateHintsImmediate: SetState<boolean>;
  sources: Source[];
  setAddUnitId: SetState<number | null>;
  setAddSourceId: SetState<number | null>;
  setAddCallsignAdditionalSourceIds: SetState<number[]>;
  setAddRows: SetState<CallsignDraftRow[]>;
  setAddSubmitting: SetState<boolean>;
  setAddValidationError: SetState<string | null>;
  setAddDrawerOpen: SetState<boolean>;
  setAddDuplicateHintsEnabled: SetState<boolean>;
  setStatus: SetState<UiStatus>;
  setCallsigns: SetState<Callsign[]>;
  refreshLookupsAndStats: () => Promise<void>;
};

export function useRerCallsignsNeoPageAddActions({
  permissions,
  addUnitId,
  addSourceId,
  addCallsignAdditionalSourceIds,
  addRows,
  addSubmitting,
  setAddDuplicateHintsImmediate,
  sources,
  setAddUnitId,
  setAddSourceId,
  setAddCallsignAdditionalSourceIds,
  setAddRows,
  setAddSubmitting,
  setAddValidationError,
  setAddDrawerOpen,
  setAddDuplicateHintsEnabled,
  setStatus,
  setCallsigns,
  refreshLookupsAndStats,
}: Args) {
  const onAppendRow = useCallback(() => {
    setAddRows((prev) => [...prev, createEmptyDraftRow()]);
    setAddDuplicateHintsImmediate(false);
  }, [setAddDuplicateHintsImmediate, setAddRows]);

  const onRemoveRow = useCallback(
    (index: number) => {
      setAddValidationError(null);
      setAddDuplicateHintsImmediate(false);
      setAddRows((prev) => {
        if (prev.length <= 1) {
          setAddDuplicateHintsEnabled(false);
          return prev;
        }
        const nextRows = prev.filter((_, rowIndex) => rowIndex !== index);
        setAddDuplicateHintsEnabled(hasAnyDuplicateHintInput(nextRows));
        return nextRows;
      });
    },
    [setAddDuplicateHintsEnabled, setAddDuplicateHintsImmediate, setAddRows, setAddValidationError],
  );

  const onClearRows = useCallback(() => {
    setAddRows([createEmptyDraftRow()]);
    setAddValidationError(null);
    setAddDuplicateHintsEnabled(false);
    setAddDuplicateHintsImmediate(false);
  }, [
    setAddDuplicateHintsEnabled,
    setAddDuplicateHintsImmediate,
    setAddRows,
    setAddValidationError,
  ]);

  const onOpenAddDrawer = useCallback(() => {
    if (!permissions.canEdit) return;
    setAddDrawerOpen(true);
    setAddValidationError(null);
    setAddCallsignAdditionalSourceIds([]);
  }, [
    permissions.canEdit,
    setAddCallsignAdditionalSourceIds,
    setAddDrawerOpen,
    setAddValidationError,
  ]);

  const resetAddDrawerState = useCallback(() => {
    setAddRows([createEmptyDraftRow()]);
    setAddUnitId(null);
    setAddSourceId(sources[0]?.id ?? null);
    setAddCallsignAdditionalSourceIds([]);
    setAddValidationError(null);
    setAddDuplicateHintsEnabled(false);
    setAddDuplicateHintsImmediate(false);
  }, [
    setAddCallsignAdditionalSourceIds,
    setAddDuplicateHintsEnabled,
    setAddDuplicateHintsImmediate,
    setAddRows,
    setAddSourceId,
    setAddUnitId,
    setAddValidationError,
    sources,
  ]);

  const onCloseAddDrawer = useCallback(() => {
    if (addSubmitting) return;
    resetAddDrawerState();
    setAddDrawerOpen(false);
  }, [addSubmitting, resetAddDrawerState, setAddDrawerOpen]);

  const onRowChange = useCallback(
    (index: number, next: CallsignDraftRow) => {
      setAddValidationError(null);
      setAddDuplicateHintsImmediate(false);
      setAddRows((prev) => {
        const nextRows = prev.map((row, rowIndex) => (rowIndex === index ? next : row));
        setAddDuplicateHintsEnabled(hasAnyDuplicateHintInput(nextRows));
        return nextRows;
      });
    },
    [setAddDuplicateHintsEnabled, setAddDuplicateHintsImmediate, setAddRows, setAddValidationError],
  );

  const onApplyPastedRows = useCallback(
    (value: string) => {
      if (!value.includes('\t') && !value.includes('\n')) {
        setAddValidationError(null);
        return;
      }
      const parsed = parseTabDelimitedInput(value);
      if (parsed.error) {
        setAddRows([createEmptyDraftRow()]);
        setAddDuplicateHintsEnabled(false);
        setAddDuplicateHintsImmediate(false);
        setAddValidationError(parsed.error);
        return;
      }
      if (parsed.rows.length === 0) {
        setAddRows([createEmptyDraftRow()]);
        setAddDuplicateHintsEnabled(false);
        setAddDuplicateHintsImmediate(false);
        setAddValidationError(QUICK_PASTE_TSV_FORMAT_ERROR);
        return;
      }
      setAddRows(parsed.rows);
      setAddValidationError(null);
      setAddDuplicateHintsEnabled(hasAnyDuplicateHintInput(parsed.rows));
      setAddDuplicateHintsImmediate(true);
    },
    [setAddDuplicateHintsEnabled, setAddDuplicateHintsImmediate, setAddRows, setAddValidationError],
  );

  const onSubmitAdd = useCallback(async () => {
    if (!permissions.canEdit) return;

    setStatus(null);
    setAddValidationError(null);

    if (addUnitId === null) {
      setAddValidationError(UNIT_SELECTION_REQUIRED_ERROR);
      return;
    }
    if (addSourceId === null) {
      setAddValidationError('Оберіть джерело');
      return;
    }
    if (!addRows.some((row) => hasAnyDraftValue(row))) {
      return;
    }

    const validation = validateDraftRows(addRows, addSourceId);
    if (!validation.valid) {
      if (validation.error === 'Заповніть хоча б один рядок') return;
      setAddValidationError(validation.error);
      return;
    }

    setAddSubmitting(true);
    setAddDuplicateHintsEnabled(false);
    setAddDuplicateHintsImmediate(false);

    try {
      const nonEmptyRows = addRows.filter((row) => hasAnyDraftValue(row));
      const created: Callsign[] = [];
      const failed: Array<{ row: CallsignDraftRow; error: string }> = [];

      for (const row of nonEmptyRows) {
        try {
          const item = await createCallsign(
            makeCreatePayload(row, addUnitId, addSourceId, addCallsignAdditionalSourceIds),
          );
          created.push(normalizeCallsign(item));
        } catch (error) {
          failed.push({ row, error: formatErrorMessage(error) });
        }
      }

      if (created.length > 0) {
        setCallsigns((prev) => [...created, ...prev]);
        await refreshLookupsAndStats();
      }

      if (failed.length === 0) {
        setAddRows([createEmptyDraftRow()]);
        setAddDrawerOpen(false);
        resetAddDrawerState();
        setStatus({ kind: 'success', text: `Додано позивних: ${created.length}` });
        return;
      }

      const failedRows = failed.map((item) => item.row);
      setAddRows(failedRows);
      setAddDuplicateHintsEnabled(hasAnyDuplicateHintInput(failedRows));
      setAddDuplicateHintsImmediate(false);
      setAddValidationError(
        failed.length === 1
          ? `Не вдалося додати 1 позивний: ${failed[0]?.error ?? 'Невідома помилка'}`
          : `Не вдалося додати ${failed.length} позивних. Перша помилка: ${failed[0]?.error ?? 'Невідома помилка'}`,
      );
      if (created.length > 0) {
        setStatus({
          kind: 'error',
          text: `Додано: ${created.length}, не вдалося: ${failed.length}`,
        });
      }
    } finally {
      setAddSubmitting(false);
    }
  }, [
    addCallsignAdditionalSourceIds,
    addRows,
    addSourceId,
    addUnitId,
    permissions.canEdit,
    refreshLookupsAndStats,
    resetAddDrawerState,
    setAddDuplicateHintsEnabled,
    setAddDuplicateHintsImmediate,
    setAddDrawerOpen,
    setAddRows,
    setAddSubmitting,
    setAddValidationError,
    setCallsigns,
    setStatus,
  ]);

  return {
    onAppendRow,
    onRemoveRow,
    onClearRows,
    onOpenAddDrawer,
    onCloseAddDrawer,
    onRowChange,
    onApplyPastedRows,
    onSubmitAdd,
  };
}
