import type { EncryptionKeyData, NetworkFreqsRes } from '../../../../Bindings';

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
    return '—';
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    const text = normalizeText(String(value));
    return text === '' ? '—' : text;
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

export function typeLabelFromKind(kind: string | null | undefined): string {
  const normalized = normalizeText(kind).toUpperCase();
  if (normalized === 'DMR' || normalized === 'DMRE') {
    return 'DMR';
  }

  return 'NFM';
}

function encryptionLabelFromCandidate(candidate: string): string | null {
  const normalized = candidate.toUpperCase();

  if (normalized.includes('ARC40')) return 'ARC40';
  if (normalized.includes('AES256') || normalized.includes('AES-256') || normalized.includes('AES 256')) return 'AES256';
  if (normalized.includes('VEDA')) return 'VEDA';

  return null;
}

export function encryptionLabelFromKey(
  key: EncryptionKeyData,
  modulationsById: Map<number, string>,
): string | null {
  const candidates = [
    key.modulationId ? modulationsById.get(key.modulationId) ?? null : null,
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
  modulationsById: Map<number, string>,
  modulationId: number | null | undefined,
  modulation: string | null | undefined,
): string {
  const labels = keys
    .map((key) =>
      typeof key === 'string' ? encryptionLabelFromCandidate(key) : encryptionLabelFromKey(key, modulationsById),
    )
    .filter((label): label is string => label !== null);

  if (labels.length === 0 && modulationId !== null && modulationId !== undefined) {
    const modulationName = modulationsById.get(modulationId) ?? null;
    if (modulationName) {
      const modulationLabel = encryptionLabelFromCandidate(modulationName) ?? modulationName;
      const normalizedLabel = encryptionLabelFromCandidate(modulationLabel) ?? modulationLabel;
      if (normalizedLabel) {
        labels.push(normalizedLabel);
      }
    }
  }

  if (labels.length === 0 && modulation) {
    const modulationLabel = encryptionLabelFromCandidate(modulation);
    if (modulationLabel) {
      labels.push(modulationLabel);
    }
  }

  const uniqueLabels = [...new Set(labels)];
  if (uniqueLabels.length === 0) {
    return '-';
  }

  return uniqueLabels.join(', ');
}

function joinCallsigns(callsigns: Array<string> | null | undefined): string {
  const normalized = (callsigns ?? [])
    .map((callsign) => normalizeText(callsign))
    .filter((callsign) => callsign !== '');
  const uniqueValues = [...new Set(normalized)];
  if (uniqueValues.length === 0) return '—';
  return uniqueValues.join(', ');
}

function compareFreqsByUnits(left: NetworkFreqsRes, right: NetworkFreqsRes): number {
  const leftUnits = parseNetworkFreqUnits(left.freq) ?? 0;
  const rightUnits = parseNetworkFreqUnits(right.freq) ?? 0;

  if (leftUnits !== rightUnits) {
    return leftUnits - rightUnits;
  }

  return left.networkFreqId - right.networkFreqId;
}

function buildGroupId(freqs: NetworkFreqsRes[]): string {
  return `freq-group:${freqs.map((freq) => freq.networkFreqId).join('-')}`;
}

function buildGroupRow(freqs: NetworkFreqsRes[], modulationsById: Map<number, string>): NetworkFreqGroupRow {
  const typeLabels = freqs.map((freq) => typeLabelFromKind(freq.kind));
  const encryptionLabels = freqs.map((freq) =>
    encryptionLabelFromKeys(freq.encryptionKeys ?? [], modulationsById, freq.modulationId, freq.modulation),
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
    callsignLabel: joinCallsigns(freqs.flatMap((freq) => freq.callsigns ?? [])),
    lastDatetime,
    isActive: freqs.some((freq) => freq.isActive),
  };
}

function buildFreqRow(
  freq: NetworkFreqsRes,
  modulationsById: Map<number, string>,
  parentGroupId: string | null = null,
): NetworkFreqRow {
  return {
    id: `freq-${freq.networkFreqId}`,
    kind: 'freq',
    parentGroupId,
    freq,
    displayFreq: normalizeFrequencyLabel(freq.freq),
    typeLabel: typeLabelFromKind(freq.kind),
    encryptionLabel: encryptionLabelFromKeys(freq.encryptionKeys ?? [], modulationsById, freq.modulationId, freq.modulation),
    callsignLabel: joinCallsigns(freq.callsigns),
  };
}

export function buildNetworkFreqRows(
  freqs: NetworkFreqsRes[],
  modulationsById: Map<number, string>,
  expandedGroupIds: string[],
): NetworkFreqTableRow[] {
  const sortedFreqs = [...freqs].sort(compareFreqsByUnits);
  const expandedGroupIdSet = new Set(expandedGroupIds);
  const rows: NetworkFreqTableRow[] = [];

  for (let index = 0; index < sortedFreqs.length; index += 1) {
    const startFreq = sortedFreqs[index];
    const startUnits = parseNetworkFreqUnits(startFreq.freq);

    if (startUnits === null) {
      rows.push(buildFreqRow(startFreq, modulationsById));
      continue;
    }

    const cluster = [startFreq];
    let cursor = index + 1;
    while (cursor < sortedFreqs.length) {
      const nextFreq = sortedFreqs[cursor];
      const nextUnits = parseNetworkFreqUnits(nextFreq.freq);
      if (nextUnits === null || nextUnits - startUnits > GROUP_SPREAD_UNITS) {
        break;
      }
      cluster.push(nextFreq);
      cursor += 1;
    }

    if (cluster.length === 1) {
      rows.push(buildFreqRow(startFreq, modulationsById));
      continue;
    }

    const groupRow = buildGroupRow(cluster, modulationsById);
    rows.push(groupRow);

    if (expandedGroupIdSet.has(groupRow.groupId)) {
      for (const freq of cluster) {
        rows.push(buildFreqRow(freq, modulationsById, groupRow.groupId));
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
  const freqByLabel = new Map(freqs.map((freq) => [normalizeFrequencyLabel(freq.freq), freq.networkFreqId]));
  const result: NetworkFreqActivityByFreq = {};

  for (const freq of freqs) {
    result[freq.networkFreqId] = [];
  }

  for (const [day, activityByFreq] of Object.entries(activityByDay)) {
    for (const [freqLabel, messageCount] of Object.entries(activityByFreq)) {
      const freqId = freqByLabel.get(normalizeFrequencyLabel(freqLabel));
      if (freqId === undefined) continue;
      result[freqId] ||= [];
      result[freqId].push({ day, messageCount });
    }
  }

  for (const series of Object.values(result)) {
    series.sort((left, right) => left.day.localeCompare(right.day));
  }

  return result;
}
