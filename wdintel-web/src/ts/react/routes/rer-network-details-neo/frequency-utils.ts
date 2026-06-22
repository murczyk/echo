import type { EncryptionKeyData, NetworkFreqsRes } from '../../../../Bindings';
import { NO_DATA_LABEL } from '../../utils/misc';

export type NetworkFreqTableSortingItem = {
  id: string;
  desc: boolean;
};

export type NetworkFreqTableStatusFilterValue = 'Усі' | 'active' | 'inactive';

export type NetworkFreqActivityPoint = {
  day: string;
  messageCount: number;
};

export type NetworkFreqActivityByFreq = Record<number, NetworkFreqActivityPoint[]>;

export type NetworkFreqRow = {
  id: string;
  kind: 'freq';
  parentGroupId: string | null;
  freq: NetworkFreqsRes;
  displayFreq: string;
  typeLabel: string;
  encryptionLabel: string;
  callsignLabel: string;
  sortFreqUnits: number | null;
  sortNetworkFreqId: number;
};

export type NetworkFreqGroupRow = {
  id: string;
  kind: 'group';
  groupId: string;
  freqIds: number[];
  displayFreq: string;
  typeLabel: string;
  encryptionLabel: string;
  messageCount: number;
  callsignLabel: string;
  lastDatetime: number | null;
  isActive: boolean;
  sortFreqUnits: number | null;
  sortNetworkFreqId: number;
};

export type NetworkFreqTableRow = NetworkFreqRow | NetworkFreqGroupRow;

const FREQ_SCALE = 10_000;
const GROUP_SPREAD_UNITS = 250;

function normalizeText(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function parseNetworkFreqUnits(value: string | null | undefined): number | null {
  const text = normalizeText(value);
  if (text === '') return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;

  return Math.round(parsed * FREQ_SCALE);
}

export function formatNetworkFreqValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return NO_DATA_LABEL;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    const text = normalizeText(String(value));
    return text === '' ? NO_DATA_LABEL : text;
  }

  return parsed.toFixed(4);
}

function normalizeFrequencyLabel(value: string): string {
  return formatNetworkFreqValue(value);
}

function collectUniqueLabels(values: string[]): string | null {
  const uniqueValues = [...new Set(values.map((value) => normalizeText(value)).filter((value) => value !== ''))];
  if (uniqueValues.length === 0) return null;
  if (uniqueValues.length === 1) return uniqueValues[0];
  return uniqueValues.join(', ');
}

export function typeLabelFromKind(kind: string | null | undefined): 'DMR' | 'NFM' | 'AM' {
  const normalized = normalizeText(kind).toUpperCase();
  if (normalized === 'DMR' || normalized === 'DMRE') return 'DMR';
  if (normalized === 'AM') return 'AM';
  return 'NFM';
}

function encryptionLabelFromCandidate(candidate: string): string | null {
  const normalized = candidate.toUpperCase();

  if (normalized.includes('ARC40')) return 'ARC40';
  if (normalized.includes('AES256') || normalized.includes('AES-256') || normalized.includes('AES 256')) return 'AES256';

  return null;
}


export function encryptionLabelFromKey(
  key: EncryptionKeyData,
  encryptionsById: Map<number, string>,
): string | null {
  const candidates = [
    key.encryptionId ? encryptionsById.get(key.encryptionId) ?? null : null,
    key.description,
    key.key,
    key.keyHash,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const label = encryptionLabelFromCandidate(candidate);
    if (label) return label;
  }

  return null;
}

export function encryptionLabelFromKeys(
  keys: Array<EncryptionKeyData | string>,
  encryptionsById: Map<number, string>,
  encryptionId: number | null | undefined,
  encryption: string | null | undefined,
): string {
  const labels = keys
    .map((key) =>
      typeof key === 'string' ? encryptionLabelFromCandidate(key) : encryptionLabelFromKey(key, encryptionsById),
    )
    .filter((label): label is string => label !== null);

  if (labels.length === 0 && encryptionId !== null && encryptionId !== undefined) {
    const encryptionName = encryptionsById.get(encryptionId) ?? null;
    if (encryptionName) {
      const encryptionLabel = encryptionLabelFromCandidate(encryptionName) ?? encryptionName;
      labels.push(encryptionLabel);
    }
  }

  if (labels.length === 0 && encryption) {
    const encryptionLabel = encryptionLabelFromCandidate(encryption);
    if (encryptionLabel) {
      labels.push(encryptionLabel);
    }
  }

  const uniqueLabels = [...new Set(labels)];
  if (uniqueLabels.length === 0) {
    return NO_DATA_LABEL;
  }

  return uniqueLabels.join(', ');
}

function joinCallsigns(callsigns: Array<string> | null | undefined): string {
  const normalized = (callsigns ?? [])
    .map((callsign) => normalizeText(callsign))
    .filter((callsign) => callsign !== '' && callsign !== 'НВ');
  const uniqueValues = [...new Set(normalized)];
  if (uniqueValues.length === 0) return NO_DATA_LABEL;
  return uniqueValues.join(', ');
}

function joinCallsignsByFreqIds(freqIds: number[], callsignsById: Map<number, string[]>): string {
  const callsigns = freqIds.flatMap((freqId) => callsignsById.get(freqId) ?? []);
  return joinCallsigns(callsigns);
}

function compareFreqsByUnits(left: NetworkFreqsRes, right: NetworkFreqsRes): number {
  if (left.isActive !== right.isActive) {
    return left.isActive ? -1 : 1;
  }

  const leftUnits = parseNetworkFreqUnits(left.freq) ?? 0;
  const rightUnits = parseNetworkFreqUnits(right.freq) ?? 0;

  if (leftUnits !== rightUnits) {
    return leftUnits - rightUnits;
  }

  return left.networkFreqId - right.networkFreqId;
}

export function sortNetworkFreqsByTableOrder(freqs: NetworkFreqsRes[]): NetworkFreqsRes[] {
  return [...freqs].sort(compareFreqsByUnits);
}

function compareFreqsByFrequencyOrder(left: NetworkFreqsRes, right: NetworkFreqsRes): number {
  const leftUnits = parseNetworkFreqUnits(left.freq) ?? 0;
  const rightUnits = parseNetworkFreqUnits(right.freq) ?? 0;

  if (leftUnits !== rightUnits) {
    return leftUnits - rightUnits;
  }

  return left.networkFreqId - right.networkFreqId;
}

function sortNetworkFreqsByFrequencyOrder(freqs: NetworkFreqsRes[]): NetworkFreqsRes[] {
  return [...freqs].sort(compareFreqsByFrequencyOrder);
}

const TABLE_SORT_COLUMNS = new Set(['displayFreq', 'typeLabel', 'encryptionLabel', 'messageCount']);
const UK_COLLATOR = new Intl.Collator('uk', { sensitivity: 'base', numeric: true });
export const DEFAULT_NETWORK_FREQ_SORTING: NetworkFreqTableSortingItem[] = [{ id: 'displayFreq', desc: false }];

function getRowIsActive(row: NetworkFreqTableRow): boolean {
  return row.kind === 'group' ? row.isActive : row.freq.isActive;
}

function getRowSortFreqUnits(row: NetworkFreqTableRow): number | null {
  return row.sortFreqUnits;
}

function getRowSortNetworkFreqId(row: NetworkFreqTableRow): number {
  return row.sortNetworkFreqId;
}

function getRowDisplayFreq(row: NetworkFreqTableRow): number | null {
  return getRowSortFreqUnits(row);
}

function getRowTypeLabel(row: NetworkFreqTableRow): string {
  return row.typeLabel;
}

function getRowEncryptionLabel(row: NetworkFreqTableRow): string {
  return row.encryptionLabel;
}

function getRowMessageCount(row: NetworkFreqTableRow): number {
  return row.kind === 'group' ? row.messageCount : row.freq.messageCount;
}

function compareText(left: string, right: string): number {
  return UK_COLLATOR.compare(left, right);
}

function compareNumber(left: number, right: number): number {
  return left - right;
}

function compareNullableNumber(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function getPrimarySortingItem(sorting: NetworkFreqTableSortingItem[]): NetworkFreqTableSortingItem {
  return sorting.find((item) => TABLE_SORT_COLUMNS.has(item.id)) ?? DEFAULT_NETWORK_FREQ_SORTING[0];
}

function compareRowsBySortingItem(left: NetworkFreqTableRow, right: NetworkFreqTableRow, sorting: NetworkFreqTableSortingItem): number {
  let result = 0;

  switch (sorting.id) {
    case 'displayFreq':
      result = compareNullableNumber(getRowDisplayFreq(left), getRowDisplayFreq(right));
      break;
    case 'typeLabel':
      result = compareText(getRowTypeLabel(left), getRowTypeLabel(right));
      break;
    case 'encryptionLabel':
      result = compareText(getRowEncryptionLabel(left), getRowEncryptionLabel(right));
      break;
    case 'messageCount':
      result = compareNumber(getRowMessageCount(left), getRowMessageCount(right));
      break;
    default:
      result = compareNumber(getRowDisplayFreq(left) ?? 0, getRowDisplayFreq(right) ?? 0);
      break;
  }

  return sorting.desc ? -result : result;
}

function compareNetworkFreqTableRows(
  left: NetworkFreqTableRow,
  right: NetworkFreqTableRow,
  sorting: NetworkFreqTableSortingItem[],
  statusFilterValue: NetworkFreqTableStatusFilterValue,
): number {
  if (statusFilterValue === 'Усі') {
    const leftActive = getRowIsActive(left);
    const rightActive = getRowIsActive(right);

    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1;
    }
  }

  const primarySorting = getPrimarySortingItem(sorting);
  const sortingResult = compareRowsBySortingItem(left, right, primarySorting);
  if (sortingResult !== 0) {
    return sortingResult;
  }

  const leftUnits = getRowSortFreqUnits(left);
  const rightUnits = getRowSortFreqUnits(right);
  const fallbackUnitsResult = compareNullableNumber(leftUnits, rightUnits);
  if (fallbackUnitsResult !== 0) {
    return fallbackUnitsResult;
  }

  return getRowSortNetworkFreqId(left) - getRowSortNetworkFreqId(right);
}

type NetworkFreqRowSegment = {
  row: NetworkFreqTableRow;
  children: NetworkFreqRow[];
};

function buildNetworkFreqRowSegments(rows: NetworkFreqTableRow[]): NetworkFreqRowSegment[] {
  const segments: NetworkFreqRowSegment[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.kind === 'group') {
      const children: NetworkFreqRow[] = [];
      let cursor = index + 1;
      while (cursor < rows.length) {
        const nextRow = rows[cursor];
        if (nextRow.kind !== 'freq' || nextRow.parentGroupId !== row.groupId) {
          break;
        }
        children.push(nextRow);
        cursor += 1;
      }
      segments.push({ row, children });
      index = cursor - 1;
      continue;
    }

    segments.push({ row, children: [] });
  }

  return segments;
}

function flattenNetworkFreqRowSegments(segments: NetworkFreqRowSegment[]): NetworkFreqTableRow[] {
  const rows: NetworkFreqTableRow[] = [];

  for (const segment of segments) {
    rows.push(segment.row, ...segment.children);
  }

  return rows;
}

export function sortNetworkFreqRowsByTableOrder(
  rows: NetworkFreqTableRow[],
  sorting: NetworkFreqTableSortingItem[],
  statusFilterValue: NetworkFreqTableStatusFilterValue,
): NetworkFreqTableRow[] {
  const segments = buildNetworkFreqRowSegments(rows);

  segments.sort((left, right) => compareNetworkFreqTableRows(left.row, right.row, sorting, statusFilterValue));

  return flattenNetworkFreqRowSegments(segments);
}

function buildGroupId(freqs: NetworkFreqsRes[]): string {
  return `freq-group:${freqs.map((freq) => freq.networkFreqId).join('-')}`;
}

function buildGroupRow(
  freqs: NetworkFreqsRes[],
  encryptionsById: Map<number, string>,
  callsignsById: Map<number, string[]>,
): NetworkFreqGroupRow {
    const firstFreq = freqs[0] ?? null;
    const typeLabels = freqs.map((freq) => freq.modulation ?? '');
  const encryptionLabels = freqs.map((freq) =>
    encryptionLabelFromKeys(freq.encryptionKeys ?? [], encryptionsById, freq.encryptionId, freq.encryption),
  );
  const counts = freqs.map((freq) => freq.messageCount);
  const lastDatetime = freqs.reduce<number | null>((current, freq) => {
    if (freq.lastDatetime === null) return current;
    if (current === null) return freq.lastDatetime;
    return Math.max(current, freq.lastDatetime);
  }, null);

  return {
    id: buildGroupId(freqs),
    kind: 'group',
    groupId: buildGroupId(freqs),
    freqIds: freqs.map((freq) => freq.networkFreqId),
    displayFreq: freqs.map((freq) => normalizeFrequencyLabel(freq.freq)).join(', '),
    typeLabel: collectUniqueLabels(typeLabels) ?? 'Змішано',
    encryptionLabel: collectUniqueLabels(encryptionLabels) ?? 'Змішано',
    messageCount: counts.reduce((sum, value) => sum + value, 0),
    callsignLabel: joinCallsignsByFreqIds(freqs.map((freq) => freq.networkFreqId), callsignsById),
    lastDatetime,
    isActive: freqs.every((freq) => freq.isActive),
    sortFreqUnits: firstFreq ? parseNetworkFreqUnits(firstFreq.freq) : null,
    sortNetworkFreqId: firstFreq?.networkFreqId ?? 0,
  };
}

function buildFreqRow(
  freq: NetworkFreqsRes,
  encryptionsById: Map<number, string>,
  callsignsById: Map<number, string[]>,
  parentGroupId: string | null = null,
): NetworkFreqRow {
  return {
    id: `freq-${freq.networkFreqId}`,
    kind: 'freq',
    parentGroupId,
    freq,
    displayFreq: normalizeFrequencyLabel(freq.freq),
    typeLabel: freq.modulation ?? '',
    encryptionLabel: encryptionLabelFromKeys(freq.encryptionKeys ?? [], encryptionsById, freq.encryptionId, freq.encryption),
    callsignLabel: joinCallsignsByFreqIds([freq.networkFreqId], callsignsById),
    sortFreqUnits: parseNetworkFreqUnits(freq.freq),
    sortNetworkFreqId: freq.networkFreqId,
  };
}

export function buildNetworkFreqRows(
  freqs: NetworkFreqsRes[],
  encryptionsById: Map<number, string>,
  callsignsById: Map<number, string[]>,
  expandedGroupIds: string[],
): NetworkFreqTableRow[] {
  const sortedFreqs = sortNetworkFreqsByFrequencyOrder(freqs);
  const expandedGroupIdSet = new Set(expandedGroupIds);
  const rows: NetworkFreqTableRow[] = [];

  for (let index = 0; index < sortedFreqs.length; index += 1) {
    const startFreq = sortedFreqs[index];
    const startUnits = parseNetworkFreqUnits(startFreq.freq);

    if (startUnits === null) {
      rows.push(buildFreqRow(startFreq, encryptionsById, callsignsById));
      continue;
    }

    const cluster = [startFreq];
    let cursor = index + 1;
    while (cursor < sortedFreqs.length) {
      const nextFreq = sortedFreqs[cursor];
      const nextUnits = parseNetworkFreqUnits(nextFreq.freq);
      if (nextUnits === null || nextUnits - startUnits > GROUP_SPREAD_UNITS || nextFreq.isActive !== startFreq.isActive) {
        break;
      }
      cluster.push(nextFreq);
      cursor += 1;
    }

    if (cluster.length === 1) {
      rows.push(buildFreqRow(startFreq, encryptionsById, callsignsById));
      continue;
    }

    const groupRow = buildGroupRow(cluster, encryptionsById, callsignsById);
    rows.push(groupRow);

    if (expandedGroupIdSet.has(groupRow.groupId)) {
      for (const freq of cluster) {
        rows.push(buildFreqRow(freq, encryptionsById, callsignsById, groupRow.groupId));
      }
    }

    index = cursor - 1;
  }

  return rows;
}

export function buildNetworkFreqActivityByFreq(
  activityByDay: Record<string, Record<string, number>>,
  freqs: NetworkFreqsRes[],
): NetworkFreqActivityByFreq {
  const freqIdsByLabel = new Map<string, number[]>();
  for (const freq of freqs) {
    const label = normalizeFrequencyLabel(freq.freq);
    const freqIds = freqIdsByLabel.get(label);
    if (freqIds) {
      freqIds.push(freq.networkFreqId);
    } else {
      freqIdsByLabel.set(label, [freq.networkFreqId]);
    }
  }

  const result: NetworkFreqActivityByFreq = {};

  for (const freq of freqs) {
    result[freq.networkFreqId] = [];
  }

  for (const [day, activityByFreq] of Object.entries(activityByDay)) {
    for (const [freqLabel, messageCount] of Object.entries(activityByFreq)) {
      const freqIds = freqIdsByLabel.get(normalizeFrequencyLabel(freqLabel));
      if (!freqIds) continue;

      for (const freqId of freqIds) {
        result[freqId] ||= [];
        result[freqId].push({ day, messageCount });
      }
    }
  }

  for (const series of Object.values(result)) {
    series.sort((left, right) => left.day.localeCompare(right.day));
  }

  return result;
}
