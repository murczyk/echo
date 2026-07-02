import type { Callsign, CreateCallsignReq } from '../../../../Bindings';
import { isNullOrUndefined, isPresent } from '../../utils/misc';
import { toUpperCaseCallsign } from './helpers-core';
import type { CallsignDraftRow, CallsignDraftValidation, CallsignEditForm } from './types';

export const QUICK_PASTE_TSV_FORMAT_ERROR =
  'Швидка вставка підтримує лише TSV-формат: позивний, посада, коментар або позивний, посада, ПІП, коментар';
export const EMPTY_CALLSIGN_ROW_ERROR =
  'Порожній запис зберегти не можна. Заповніть "Позивний" або "ПІП", або додайте інші дані.';
export const LEGACY_CALLSIGN_CLEAR_ERROR =
  'Не можна залишити запис повністю порожнім. Заповніть "Позивний" або "ПІП", або залиште інші дані.';
export const RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR =
  'Для джерела "РО" поле "Частота" є обов’язковим.';

export function createEmptyDraftRow(): CallsignDraftRow {
  return {
    callsign: '',
    position: '',
    fullName: '',
    comment: '',
    developing: false,
    radioFreq: '',
  };
}

export function hasAnyDraftValue(row: CallsignDraftRow): boolean {
  return (
    [row.callsign, row.position, row.fullName, row.comment, row.radioFreq].some(
      (value) => value.trim() !== '',
    ) || row.developing
  );
}

export function validateDraftRows(
  rows: CallsignDraftRow[],
  _sourceId: number | null,
): CallsignDraftValidation {
  if (rows.length === 0) return { valid: false, error: 'Немає рядків для додавання' };

  const nonEmptyRows = rows.filter((row) => hasAnyDraftValue(row));
  if (nonEmptyRows.length === 0) return { valid: false, error: 'Заповніть хоча б один рядок' };

  const emptyIdentityAndLegacyContent = nonEmptyRows.find((row) => {
    const hasIdentity = row.callsign.trim() !== '' || row.fullName.trim() !== '';
    if (hasIdentity) return false;

    return (
      [row.position, row.comment, row.radioFreq].every((value) => value.trim() === '') &&
      !row.developing
    );
  });
  if (emptyIdentityAndLegacyContent) return { valid: false, error: EMPTY_CALLSIGN_ROW_ERROR };

  if (_sourceId === 2) {
    const missingRadioFreq = nonEmptyRows.find((row) => row.radioFreq.trim() === '');
    if (missingRadioFreq) {
      return { valid: false, error: RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR };
    }
  }

  return { valid: true, error: null };
}

export function validateEditForm(form: CallsignEditForm | null): CallsignDraftValidation {
  if (!form) return { valid: false, error: 'Не вибрано позивний для редагування' };
  const hasIdentity = form.callsign.trim() !== '' || form.fullName.trim() !== '';
  const hasLegacyContent =
    [form.position, form.comment, form.radioFreq].some((value) => value.trim() !== '') ||
    form.developing ||
    form.unitId > 0 ||
    isPresent(form.sourceId) ||
    form.callsignAdditionalSourceIds.length > 0;
  if (!hasIdentity && !hasLegacyContent) {
    return { valid: false, error: LEGACY_CALLSIGN_CLEAR_ERROR };
  }
  if (form.sourceId === 2 && form.radioFreq.trim() === '') {
    return { valid: false, error: RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR };
  }
  return { valid: true, error: null };
}

function sanitizeCallsignAdditionalSourceIds(
  callsignAdditionalSourceIds: number[],
  primarySourceId: number | null | undefined,
): number[] {
  const uniqueIds = Array.from(
    new Set(callsignAdditionalSourceIds.filter((item) => Number.isInteger(item) && item > 0)),
  ).sort((left, right) => left - right);
  if (isNullOrUndefined(primarySourceId)) return uniqueIds;
  return uniqueIds.filter((sourceId) => sourceId !== primarySourceId);
}

export function callsignToEditForm(callsign: Callsign): CallsignEditForm {
  return {
    id: callsign.id,
    callsign: toUpperCaseCallsign(callsign.callsign),
    position: callsign.position,
    fullName: callsign.fullName,
    comment: callsign.comment,
    callsignAdditionalSourceIds: sanitizeCallsignAdditionalSourceIds(
      callsign.callsignAdditionalSources,
      callsign.sourceId,
    ),
    unitId: callsign.unitId,
    sourceId: callsign.sourceId,
    developing: callsign.developing,
    radioFreq: callsign.radioFreq ?? '',
    createdAt: callsign.createdAt,
    active: callsign.active,
  };
}

export function parseTabDelimitedInput(input: string): {
  rows: CallsignDraftRow[];
  error: string | null;
} {
  const trimmed = input.replace(/(?:\r\n|\r|\n)+$/, '');
  if (!trimmed) {
    return { rows: [], error: null };
  }

  const rows: CallsignDraftRow[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const nextRows = (() => {
      const cells = line.split('\t');
      if (cells.length === 3) {
        return [createDraftRow(cells[0], cells[1], '', cells[2])];
      }
      if (cells.length === 4) {
        return [createDraftRow(cells[0], cells[1], cells[2], cells[3])];
      }
      return null;
    })();

    if (isNullOrUndefined(nextRows)) {
      return { rows: [], error: QUICK_PASTE_TSV_FORMAT_ERROR };
    }

    rows.push(...nextRows);
  }

  return { rows, error: null };
}

function createDraftRow(
  callsign: string,
  position: string,
  fullName: string,
  comment: string,
): CallsignDraftRow {
  return {
    callsign: toUpperCaseCallsign(callsign.trim()),
    position: position.trim(),
    fullName: fullName.trim(),
    comment: comment.trim(),
    developing: false,
    radioFreq: '',
  };
}

export function makeUpdatePayload(form: CallsignEditForm): Callsign {
  const callsignAdditionalSourceIds = sanitizeCallsignAdditionalSourceIds(
    form.callsignAdditionalSourceIds,
    form.sourceId,
  );
  return {
    id: form.id,
    callsign: toUpperCaseCallsign(form.callsign).trim(),
    position: form.position.trim(),
    fullName: form.fullName.trim(),
    comment: form.comment.trim(),
    unitId: form.unitId,
    active: form.active,
    sourceId: form.sourceId,
    callsignAdditionalSources: callsignAdditionalSourceIds,
    createdAt: form.createdAt,
    developing: form.developing,
    radioFreq: form.radioFreq.trim() === '' ? '' : form.radioFreq.trim(),
  };
}

export function makeCreatePayload(
  row: CallsignDraftRow,
  unitId: number,
  sourceId: number,
  callsignAdditionalSourceIds: number[],
): CreateCallsignReq {
  const safeCallsignAdditionalSourceIds = sanitizeCallsignAdditionalSourceIds(
    callsignAdditionalSourceIds,
    sourceId,
  );
  return {
    callsign: toUpperCaseCallsign(row.callsign).trim(),
    position: row.position.trim(),
    fullName: row.fullName.trim(),
    comment: row.comment.trim(),
    unitId,
    sourceId,
    callsignAdditionalSources: safeCallsignAdditionalSourceIds,
    developing: row.developing,
    radioFreq: row.radioFreq.trim() === '' ? '' : row.radioFreq.trim(),
  };
}
