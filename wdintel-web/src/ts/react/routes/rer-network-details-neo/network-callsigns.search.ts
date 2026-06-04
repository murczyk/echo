import { NO_DATA_LABEL, formatDateTime24 } from '../../utils/misc';
import {
  type NetworkCallsignCatalogGroupView,
  type NetworkCallsignInterceptedView,
  type NetworkCallsignRowView,
} from './network-callsigns.types';

function normalizeSearchNeedle(value: string): string {
  return value.trim().toLowerCase();
}

function isSearchMatch(values: Array<string | number | null | undefined>, query: string): boolean {
  const needle = normalizeSearchNeedle(query);
  if (needle === '') return true;
  return values.some((value) => {
    if (value === null || value === undefined) return false;
    return String(value).toLowerCase().includes(needle);
  });
}

export function formatNetworkCallsignDatetime(value: number | null): string {
  return value === null ? NO_DATA_LABEL : formatDateTime24(value);
}

export function filterNetworkCallsignRows(rows: NetworkCallsignRowView[], query: string): NetworkCallsignRowView[] {
  if (normalizeSearchNeedle(query) === '') return rows;
  return rows.filter((row) =>
    isSearchMatch(
      [
        row.callsign,
        row.position,
        row.unitName,
        row.comment,
        row.sourceName,
        row.statusLabel,
        row.lastDatetime === null ? null : formatNetworkCallsignDatetime(row.lastDatetime),
        row.messageCount,
      ],
      query,
    ),
  );
}

export function filterCatalogCallsignGroups(
  groups: NetworkCallsignCatalogGroupView[],
  query: string,
): NetworkCallsignCatalogGroupView[] {
  if (normalizeSearchNeedle(query) === '') return groups;

  return groups
    .map((group) => ({
      ...group,
      knownCallsigns: group.knownCallsigns.filter((knownCallsign) =>
        isSearchMatch(
          [
            knownCallsign.callsign,
            knownCallsign.position,
            knownCallsign.unitName,
            knownCallsign.comment,
            knownCallsign.sourceName,
            group.callsign,
            group.messageCount,
            group.lastDatetime === null ? null : formatNetworkCallsignDatetime(group.lastDatetime),
            formatNetworkCallsignDatetime(knownCallsign.createdAt),
          ],
          query,
        ),
      ),
    }))
    .filter((group) => group.knownCallsigns.length > 0);
}

export function filterInterceptedCallsigns(
  rows: NetworkCallsignInterceptedView[],
  query: string,
): NetworkCallsignInterceptedView[] {
  if (normalizeSearchNeedle(query) === '') return rows;

  return rows.filter((row) =>
    isSearchMatch(
      [
        row.callsign,
        row.messageCount,
        row.lastDatetime === null ? null : formatNetworkCallsignDatetime(row.lastDatetime),
        row.freqs?.join(' '),
        row.isInDictionary ? 'dictionary' : null,
      ],
      query,
    ),
  );
}
