import type { RerDutyQueryStateWf } from '../Bindings';
import { emptyArrToNull } from './react/utils/misc';
import { getUnitIdFilterValue } from './react/utils/unit-search';

function readFilterValues(raw: Record<string, unknown>, keys: string[]): string[] | null {
  for (const key of keys) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value == null) continue;
    return emptyArrToNull(value as string[] | null);
  }
  return null;
}

function readUnitIds(raw: Record<string, unknown>, keys: string[]): number[] {
  for (const key of keys) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    return value.filter((unitId): unitId is number => Number.isSafeInteger(unitId) && unitId > 0);
  }
  return [];
}

function mergeUnitFilterValues(
  raw: Record<string, unknown>,
  valueKeys: string[],
  idKeys: string[],
): string[] | null {
  const values = readFilterValues(raw, valueKeys) ?? [];
  const unitIdValues = readUnitIds(raw, idKeys).map(getUnitIdFilterValue);
  return emptyArrToNull([...new Set([...unitIdValues, ...values])]);
}

export function normalizeRerDutyQueryStateWf(raw: Record<string, unknown>): RerDutyQueryStateWf {
  return {
    groupsSelected: readFilterValues(raw, ['groupsSelected', 'groups_selected']),
    groupsDenied: readFilterValues(raw, ['groupsDenied', 'groups_denied']),
    sendersSelected: readFilterValues(raw, ['sendersSelected', 'senders_selected']),
    deniedSenders: readFilterValues(raw, ['deniedSenders', 'denied_senders']),
    freqsSelected: readFilterValues(raw, ['freqsSelected', 'freqs_selected']),
    freqsDenied: readFilterValues(raw, ['freqsDenied', 'freqs_denied']),
    postsSelected: readFilterValues(raw, ['postsSelected', 'posts_selected']),
    postsDenied: readFilterValues(raw, ['postsDenied', 'posts_denied']),
    unitsSelected: mergeUnitFilterValues(
      raw,
      ['unitsSelected', 'units_selected'],
      ['selectedUnitIds', 'selected_unit_ids'],
    ),
    unitsDenied: mergeUnitFilterValues(
      raw,
      ['unitsDenied', 'units_denied'],
      ['deniedUnitIds', 'denied_unit_ids'],
    ),
    selectedUnitIds: null,
    deniedUnitIds: null,
    unitsExactMatchOnly: (raw.unitsExactMatchOnly ?? raw.units_exact_match_only ?? false) as
      boolean | null,
    lastViewedMessageId: (raw.lastViewedMessageId ?? raw.last_viewed_message_id ?? null) as
      number | null,
    highlightKeywordsEnabled: (raw.highlightKeywordsEnabled ??
      raw.highlight_keywords_enabled ??
      null) as boolean | null,
    highlightKeywordSetId: (raw.highlightKeywordSetId ?? raw.highlight_keyword_set_id ?? null) as
      number | null,
  };
}
