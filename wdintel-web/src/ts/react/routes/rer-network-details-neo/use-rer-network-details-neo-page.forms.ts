import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import type { Network, NetworkFreqsRes } from '../../../../Bindings';
import {
  APP_TIME_ZONE,
  formatDateTimeInputValueInTimeZone,
  formatUtcDateInputValue,
} from '../../utils/misc';
import type {
  NetworkDescriptionForm,
  NetworkEditForm,
  NetworkFreqCreateWizardForm,
  NetworkFreqEditForm,
  NetworkFreqTechDataForm,
  NetworkPelengDateRange,
  NetworkRelationsDateRange,
} from './use-rer-network-details-neo-page.types';

dayjs.extend(utc);
dayjs.extend(timezone);

export function sortDescriptionsByCreatedAtDesc(descriptions: Network['descriptions']): Network['descriptions'] {
  return [...descriptions].sort((left, right) => right.createdAt - left.createdAt);
}

export function toNetworkDescriptionForm(topic: string, description: string, networkFreqId: number | null): NetworkDescriptionForm {
  return {
    topic,
    description,
    networkFreqId,
  };
}

export function toNetworkFreqCreateWizardForm(): NetworkFreqCreateWizardForm {
  return {
    freq: '',
    kind: 'DMR',
    modulationId: null,
    description: '',
    activeFrom: '',
    activeTo: '',
    encryptionKeyIds: [],
  };
}

export function typeLabelFromKind(kind: string | null | undefined): 'DMR' | 'DMRe' | 'NFM' {
  const normalized = kind?.trim().toUpperCase() ?? '';
  if (normalized === 'DMR') return 'DMR';
  if (normalized === 'DMRE') return 'DMRe';
  return 'NFM';
}

export function formatDateInputValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return formatUtcDateInputValue(date);
}

export function toNetworkFreqEditForm(freq: NetworkFreqsRes): NetworkFreqEditForm {
  return {
    networkFreqId: freq.networkFreqId,
    kind: typeLabelFromKind(freq.kind),
    modulationId: freq.modulationId,
    activeFrom: formatDateInputValue(freq.activeFrom),
    activeTo: formatDateInputValue(freq.activeTo),
  };
}

export function toNetworkFreqTechDataForm(freq: NetworkFreqsRes): NetworkFreqTechDataForm {
  return {
    networkFreqId: freq.networkFreqId,
    encryptionKeyIds: [...freq.encryptionKeyIds],
  };
}

export function toNetworkEditForm(network: Network): NetworkEditForm {
  return {
    id: network.id,
    name: network.name,
    location: network.location,
    radioStation: network.radioStation ?? '',
    purpose: network.purpose ?? '',
    operationMode: network.operationMode ?? '',
    operationType: network.operationType ?? '',
    operationPeriod: network.operationPeriod ?? '',
    status: network.status,
    aorIds: [...network.aorIds],
    unitIds: [...(network.unitIds ?? [])],
    postIds: [...network.postIds],
  };
}

export function parseNetworkDetailsDateInput(value: string): number | null {
  const text = value.trim();
  if (text === '') return null;
  const parsed = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseNetworkDetailsDateInputExclusiveEnd(value: string): number | null {
  const since = parseNetworkDetailsDateInput(value);
  return since === null ? null : since + 24 * 60 * 60 * 1000;
}

export function getDefaultNetworkRelationsDateRange(now: Date = new Date()): NetworkRelationsDateRange {
  const today = dayjs(now).tz(APP_TIME_ZONE).startOf('day');
  const from = today.subtract(1, 'month');

  return {
    relationsSince: from.format('YYYY-MM-DD'),
    relationsTill: today.format('YYYY-MM-DD'),
  };
}

export function normalizeNetworkRelationsSinceChange(currentSince: string, currentTill: string, nextSince: string): NetworkRelationsDateRange {
  const trimmedSince = nextSince.trim();
  if (trimmedSince === '') {
    return {
      relationsSince: currentSince,
      relationsTill: currentTill,
    };
  }

  if (currentTill.trim() !== '' && trimmedSince > currentTill.trim()) {
    return {
      relationsSince: trimmedSince,
      relationsTill: trimmedSince,
    };
  }

  return {
    relationsSince: trimmedSince,
    relationsTill: currentTill.trim(),
  };
}

export function normalizeNetworkRelationsTillChange(currentSince: string, currentTill: string, nextTill: string): NetworkRelationsDateRange {
  const trimmedTill = nextTill.trim();
  if (trimmedTill === '') {
    return {
      relationsSince: currentSince,
      relationsTill: currentTill,
    };
  }

  if (currentSince.trim() !== '' && trimmedTill < currentSince.trim()) {
    return {
      relationsSince: trimmedTill,
      relationsTill: trimmedTill,
    };
  }

  return {
    relationsSince: currentSince.trim(),
    relationsTill: trimmedTill,
  };
}

export function getDefaultNetworkPelengDateRange(network: Network | null, now: Date = new Date()): NetworkPelengDateRange {
  const tillDate = network?.activeTo !== null && network?.activeTo !== undefined ? new Date(network.activeTo) : now;
  const sinceDate = network?.activeFrom !== null && network?.activeFrom !== undefined
    ? new Date(network.activeFrom)
    : dayjs(tillDate).tz(APP_TIME_ZONE).subtract(1, 'month').toDate();

  return {
    pelengSince: formatDateTimeInputValueInTimeZone(sinceDate, APP_TIME_ZONE),
    pelengTill: formatDateTimeInputValueInTimeZone(tillDate, APP_TIME_ZONE),
  };
}

export function normalizeNetworkPelengSinceChange(currentSince: string, currentTill: string, nextSince: string): NetworkPelengDateRange {
  const trimmedSince = nextSince.trim();
  if (trimmedSince === '') {
    return {
      pelengSince: currentSince,
      pelengTill: currentTill,
    };
  }

  if (currentTill.trim() !== '' && trimmedSince > currentTill.trim()) {
    return {
      pelengSince: trimmedSince,
      pelengTill: trimmedSince,
    };
  }

  return {
    pelengSince: trimmedSince,
    pelengTill: currentTill.trim(),
  };
}

export function normalizeNetworkPelengTillChange(currentSince: string, currentTill: string, nextTill: string): NetworkPelengDateRange {
  const trimmedTill = nextTill.trim();
  if (trimmedTill === '') {
    return {
      pelengSince: currentSince,
      pelengTill: currentTill,
    };
  }

  if (currentSince.trim() !== '' && trimmedTill < currentSince.trim()) {
    return {
      pelengSince: trimmedTill,
      pelengTill: trimmedTill,
    };
  }

  return {
    pelengSince: currentSince.trim(),
    pelengTill: trimmedTill,
  };
}
