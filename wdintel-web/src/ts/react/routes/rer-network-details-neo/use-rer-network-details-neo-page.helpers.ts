import type { Network, User } from '../../../../Bindings';
import { NO_DATA_LABEL } from '../../utils/misc';
import { FREQUENCY_FORMAT_ERROR } from './use-rer-network-details-neo-page.constants';
import type { DisplayNetworkStatus } from './use-rer-network-details-neo-page.types';

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

export function normalizeLookupName(value: string | null | undefined, fallback: string = NO_DATA_LABEL): string {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? fallback : trimmed;
}

export function formatClassicNetworkHeaderName(networkName: string | null | undefined, unitNames: string[]): string {
  const name = networkName?.trim() ?? '';
  const units = unitNames.map((unitName) => unitName.trim()).filter((unitName) => unitName !== '');

  if (name === '' && units.length === 0) {
    return NO_DATA_LABEL;
  }

  return ['р/м', name, units.join(', ')].filter((part) => part !== '').join(' ');
}

export function networkStatusDisplay(network: Network | null): DisplayNetworkStatus {
  if (!network) {
    return { label: 'Завантаження', tone: 'warning' };
  }

  if (network.deleted) {
    return { label: 'Видалена', tone: 'warning' };
  }

  return network.status === 'NetworkActive'
    ? { label: 'Активна', tone: 'success' }
    : { label: 'Неактивна', tone: 'warning' };
}

export function displayNetworkType(kind: string | null | undefined): string {
  switch (kind) {
    case 'VHF':
      return 'УКХ';
    case 'DMR':
      return 'DMR';
    case 'DMRe':
      return 'DMRe';
    default:
      return normalizeLookupName(kind);
  }
}

export function isValidFrequencyFormat(freq: string): boolean {
  const trimmed = freq.trim();
  if (trimmed === '') return false;

  const parts = trimmed.split('.');
  if (parts.length !== 2) return false;

  const [wholePart, decimalPart] = parts;
  return wholePart.length === 3 && decimalPart.length === 4 && /^\d{3}$/.test(wholePart) && /^\d{4}$/.test(decimalPart);
}

export function getFrequencyFormatError(freq: string): string | null {
  const trimmed = freq.trim();
  if (trimmed === '') return 'Це поле обов\'язкове';
  if (!isValidFrequencyFormat(trimmed)) return FREQUENCY_FORMAT_ERROR;
  return null;
}

export function formatNetworkFreqRange(freqs: Array<Network['freqs'][number]>): string {
  const kinds = [...new Set(freqs.map((freq) => displayNetworkType(freq.kind)).filter((kind) => kind !== NO_DATA_LABEL))];
  return kinds.length === 0 ? NO_DATA_LABEL : kinds.join(', ');
}

export function formatTransferTypeLabel(freqs: Array<Network['freqs'][number]>, modulationsById: Map<number, string>): string {
  const labels = freqs
    .map((freq) => freq.modulationId)
    .filter((modulationId): modulationId is number => modulationId !== null && modulationId !== undefined)
    .map((modulationId) => modulationsById.get(modulationId) ?? `#${modulationId}`)
    .filter((label) => label.trim() !== '');

  const uniqueLabels = [...new Set(labels)];
  return uniqueLabels.length === 0 ? NO_DATA_LABEL : uniqueLabels.join(', ');
}

export function buildLookupMap<T extends { id: number; name: string }>(items: T[]): Map<number, string> {
  return new Map(items.map((item) => [item.id, item.name]));
}

export function canDeleteNetwork(user: User | null): boolean {
  const roles = new Set(user?.roles ?? []);
  return canManageNetworkActions(roles);
}

export function canEditNetwork(user: User | null): boolean {
  const roles = new Set(user?.roles ?? []);
  return canManageNetworkActions(roles);
}

export function canManageDescriptions(user: User | null): boolean {
  const roles = new Set(user?.roles ?? []);
  return roles.has('Admin') || (roles.has('UnitsEditor') && (roles.has('Rer') || roles.has('Full')));
}

export function canManageNetworkCallsignActions(user: User | null): boolean {
  const roles = new Set(user?.roles ?? []);
  return roles.has('Admin') || (roles.has('UnitsEditor') && (roles.has('Rer') || roles.has('Full')));
}

function canManageNetworkActions(roles: Set<string>): boolean {
  return roles.has('Admin') || (roles.has('UnitsEditor') && (roles.has('Rer') || roles.has('Full')));
}
