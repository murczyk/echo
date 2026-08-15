import type { RerDutyQueryStateWf } from '../Bindings';
import { emptyArrToNull } from './react/utils/misc';

function readFilterValues(raw: Record<string, unknown>, keys: string[]): string[] | null {
  for (const key of keys) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value == null) continue;
    return emptyArrToNull(value as string[] | null);
  }
  return null;
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
    unitsSelected: readFilterValues(raw, ['unitsSelected', 'units_selected']),
    unitsDenied: readFilterValues(raw, ['unitsDenied', 'units_denied']),
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
