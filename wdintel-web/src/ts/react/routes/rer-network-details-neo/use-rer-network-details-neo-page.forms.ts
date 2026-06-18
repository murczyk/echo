import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import type { CreateNetworkReq, Network, NetworkFreqsRes } from '../../../../Bindings';
import {
  APP_TIME_ZONE,
  formatUtcDateInputValue,
} from '../../utils/misc';
import type {
  NetworkDescriptionForm,
  NetworkEditForm,
  NetworkFreqCreateWizardForm,
  NetworkFreqEditForm,
  NetworkFreqKind,
  NetworkUpsertForm,
  NetworkPelengDateRange,
  NetworkRelationsDateRange,
} from './use-rer-network-details-neo-page.types';
import { getFrequencyFormatError } from './use-rer-network-details-neo-page.helpers';
import { NETWORK_STATUS_ACTIVE } from './network-status';

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

export function createDefaultNetworkUpsertForm(): NetworkUpsertForm {
  return {
    id: null,
    name: 'управління',
    location: '',
    radioStation: '',
    purpose: 'для управління підлеглим особовим складом',
    operationMode: 'дуплекс',
    operationType: 'ведення службового радіообміну',
    operationPeriod: 'цілодобово',
    status: NETWORK_STATUS_ACTIVE,
    aorIds: [],
    unitIds: [],
    postIds: [],
    freq: '',
    kind: 'DMR',
    modulationId: null,
    activeFrom: '',
    activeTo: '',
    encryptionKeyIds: [],
  };
}

export function toNetworkFreqCreateWizardForm(): NetworkFreqCreateWizardForm {
  return {
    freq: '',
    modulation: 'DMR',
    encryptionId: null,
    activeFrom: '',
    activeTo: '',
    encryptionKeyIds: [],
  };
}

export function typeLabelFromKind(kind: string | null | undefined): 'DMR' | 'NFM' | 'AM' {
  const normalized = kind?.trim().toUpperCase() ?? '';
  if (normalized === 'DMR' || normalized === 'DMRE') return 'DMR';
  if (normalized === 'AM') return 'AM';
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
    freq: freq.freq,
    modulation: typeLabelFromKind(freq.modulation),
    encryptionId: freq.encryptionId,
    activeFrom: formatDateInputValue(freq.activeFrom),
    activeTo: formatDateInputValue(freq.activeTo),
    encryptionKeyIds: [...freq.encryptionKeyIds],
  };
}

export function toNetworkEditForm(network: Network): NetworkEditForm {
  return {
    ...createDefaultNetworkUpsertForm(),
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

export function toCreateNetworkReq(form: NetworkUpsertForm): CreateNetworkReq {
  return {
    freqs: [
      {
        freq: form.freq.trim(),
        modulation: toModulationString(form.kind),
        encryptionId: form.modulationId,
        encryptionKeyIds: [...form.encryptionKeyIds],
        description: null,
        activeFrom: parseNetworkDetailsDateInput(form.activeFrom),
        activeTo: parseNetworkDetailsDateInputExclusiveEnd(form.activeTo),
      },
    ],
    unitIds: form.unitIds.length === 0 ? null : [...form.unitIds],
    areaOfResponsibilityIds: form.aorIds.length === 0 ? null : [...form.aorIds],
    name: form.name.trim(),
    location: form.location.trim(),
    radioStation: form.radioStation.trim() === '' ? null : form.radioStation.trim(),
    purpose: form.purpose.trim() === '' ? null : form.purpose.trim(),
    operationMode: form.operationMode.trim() === '' ? null : form.operationMode.trim(),
    operationType: form.operationType.trim() === '' ? null : form.operationType.trim(),
    operationPeriod: form.operationPeriod.trim() === '' ? null : form.operationPeriod.trim(),
    postIds: [...form.postIds],
    descriptions: [],
  };
}

function toModulationString(kind: NetworkFreqKind): string {
  return kind === 'DMRe' ? 'DMR' : kind;
}

export type NetworkUpsertValidationError = {
  name: string | null;
  location: string | null;
  aorIds: string | null;
  freq: string | null;
  modulationId: string | null;
  activeFrom: string | null;
};

export function getNetworkUpsertValidationError(
  form: NetworkUpsertForm | null,
  options: { includeFrequency: boolean } = { includeFrequency: true },
): NetworkUpsertValidationError | null {
  if (!form) return null;

  const name = form.name.trim() === '' ? 'Назва є обовʼязковою' : null;
  const location = form.location.trim() === '' ? 'Район функціонування/розгортання є обовʼязковим' : null;
  const aorIds = form.aorIds.length === 0 ? 'Потрібно вибрати принаймні одну смугу' : null;
  const freq = options.includeFrequency ? getFrequencyFormatError(form.freq) : null;
  const modulationId = options.includeFrequency && form.modulationId === null ? 'Потрібно вибрати модуляцію' : null;
  const activeFrom = options.includeFrequency && parseNetworkDetailsDateInput(form.activeFrom) === null ? 'Потрібно вказати дату початку' : null;

  const error = {
    name,
    location,
    aorIds,
    freq,
    modulationId,
    activeFrom,
  };

  return Object.values(error).every((value) => value === null) ? null : error;
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
    pelengSince: dayjs(sinceDate).tz(APP_TIME_ZONE).format('YYYY-MM-DD'),
    pelengTill: dayjs(tillDate).tz(APP_TIME_ZONE).format('YYYY-MM-DD'),
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
