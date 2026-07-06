import type { Network, User } from '../../../../Bindings';
import { NO_DATA_LABEL } from '../../utils/misc';
import { FREQUENCY_FORMAT_ERROR } from './use-rer-network-details-neo-page.constants';
import type { DisplayNetworkStatus } from './use-rer-network-details-neo-page.types';
import { NETWORK_STATUS_ACTIVE } from './network-status';
import { hasAnyRole, hasRole } from '../../utils/roles';

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

export function normalizeLookupName(
  value: string | null | undefined,
  fallback: string = NO_DATA_LABEL,
): string {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? fallback : trimmed;
}

export function formatClassicNetworkHeaderName(
  networkName: string | null | undefined,
  unitNames: string[],
): string {
  const name = networkName?.trim() ?? '';
  const units = unitNames.map((unitName) => unitName.trim()).filter((unitName) => unitName !== '');

  if (name === '' && units.length === 0) {
    return NO_DATA_LABEL;
  }

  return ['р/м', name, units.join(', ')].filter((part) => part !== '').join(' ');
}

export function formatAorSummaryText(aorLabels: string[], hiddenCount: number): string {
  const labels = aorLabels.map((label) => label.trim()).filter((label) => label !== '');

  if (labels.length === 0) {
    return hiddenCount > 0 ? `(+${hiddenCount})` : NO_DATA_LABEL;
  }

  return `${labels.join(', ')}${hiddenCount > 0 ? ` (+${hiddenCount})` : ''}`;
}

export function networkStatusDisplay(network: Network | null): DisplayNetworkStatus {
  if (!network) {
    return { label: 'Завантаження', tone: 'warning' };
  }

  if (network.deleted) {
    return { label: 'Видалена', tone: 'warning' };
  }

  return network.status === NETWORK_STATUS_ACTIVE
    ? { label: 'Активна', tone: 'success' }
    : { label: 'Неактивна', tone: 'warning' };
}

export function displayNetworkType(modulation: string | null | undefined): string {
  switch (modulation) {
    case 'NFM':
      return 'УКХ';
    case 'DMR':
      return 'DMR';
    case 'DMRe':
      return 'DMR';
    case 'AM':
      return 'AM';
    case '':
    case null:
    case undefined:
      return 'Не визначено';
    default:
      return normalizeLookupName(modulation);
  }
}

export function isValidFrequencyFormat(freq: string): boolean {
  const trimmed = freq.trim();
  if (trimmed === '') return false;

  const parts = trimmed.split('.');
  if (parts.length !== 2) return false;

  const [wholePart, decimalPart] = parts;
  return (
    wholePart.length === 3 &&
    decimalPart.length === 4 &&
    /^\d{3}$/.test(wholePart) &&
    /^\d{4}$/.test(decimalPart)
  );
}

export function getFrequencyFormatError(freq: string): string | null {
  const trimmed = freq.trim();
  if (trimmed === '') return "Це поле обов'язкове";
  if (!isValidFrequencyFormat(trimmed)) return FREQUENCY_FORMAT_ERROR;
  return null;
}

export function formatNetworkFreqRange(freqs: Array<Network['freqs'][number]>): string {
  const modulations = [
    ...new Set(
      freqs.map((freq) => displayNetworkType(freq.modulation)).filter((m) => m !== NO_DATA_LABEL),
    ),
  ];
  return modulations.length === 0 ? NO_DATA_LABEL : modulations.join(', ');
}

export function formatTransferTypeLabel(
  freqs: Array<Network['freqs'][number]>,
  encryptionsById: Map<number, string>,
): string {
  const labels = freqs
    .map((freq) => freq.encryptionId)
    .filter(
      (encryptionId): encryptionId is number => encryptionId !== null && encryptionId !== undefined,
    )
    .map((encryptionId) => encryptionsById.get(encryptionId) ?? `#${encryptionId}`)
    .filter((label) => label.trim() !== '');

  const uniqueLabels = [...new Set(labels)];
  return uniqueLabels.length === 0 ? NO_DATA_LABEL : uniqueLabels.join(', ');
}

export function buildLookupMap<T extends { id: number; name: string }>(
  items: T[],
): Map<number, string> {
  return new Map(items.map((item) => [item.id, item.name]));
}

export function canDeleteNetwork(user: User | null): boolean {
  return canManageNetworkActions(user?.roles);
}

export function canEditNetwork(user: User | null): boolean {
  return canManageNetworkActions(user?.roles);
}

export function canManageDescriptions(user: User | null): boolean {
  return (
    hasRole(user?.roles, 'Admin') ||
    (hasRole(user?.roles, 'UnitsEditor') && hasRole(user?.roles, 'Rer'))
  );
}

export function canManageNetworkCallsignActions(user: User | null): boolean {
  return (
    hasRole(user?.roles, 'Admin') ||
    (hasRole(user?.roles, 'UnitsEditor') && hasRole(user?.roles, 'Rer'))
  );
}

export function canDeleteCatalogCallsign(user: User | null): boolean {
  return (
    hasRole(user?.roles, 'Admin') ||
    (hasRole(user?.roles, 'CallsignsEditor') && hasRole(user?.roles, 'Rer'))
  );
}

export function canViewNetworkActivityTab(user: User | null): boolean {
  return hasRole(user?.roles, 'Rer');
}

export function canViewNetworkRelationsTab(user: User | null): boolean {
  return hasAnyRole(user?.roles, ['Rer', 'Api', 'ApiAgent']);
}

function canManageNetworkActions(roles: readonly string[] | null | undefined): boolean {
  return hasRole(roles, 'Admin') || (hasRole(roles, 'UnitsEditor') && hasRole(roles, 'Rer'));
}
