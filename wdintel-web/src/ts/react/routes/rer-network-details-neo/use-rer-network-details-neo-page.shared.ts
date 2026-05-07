import type { AreaOfResponsibility, ModulationRec, Network, NetworkDescrType, NetworkStatus, Post, Unit, User } from '../../../../Bindings';

export type NetworkEditForm = {
  id: number;
  name: string;
  location: string;
  radioStation: string;
  purpose: string;
  operationMode: string;
  operationType: string;
  operationPeriod: string;
  status: NetworkStatus;
  aorIds: number[];
  unitIds: number[];
  postIds: number[];
};

export type NetworkDescriptionForm = {
  description: string;
  networkFreqId: number | null;
};

export type NetworkOption = {
  id: number;
  label: string;
};

export type NetworkDescriptionMode = 'create' | 'edit';

export type NetworkDescriptionTab = 'justifications' | 'signs';

export type NetworkDetailsNeoPageState = {
  network: Network | null;
  callsignCount: number | null;
  currentUser: User | null;
  units: Unit[];
  posts: Post[];
  aors: AreaOfResponsibility[];
  modulations: ModulationRec[];
  loading: boolean;
  referenceLoading: boolean;
  error: string | null;
  referenceWarning: string | null;
  callsignWarning: string | null;
  expandedDescriptionIds: number[];
  descriptionDrawerOpen: boolean;
  descriptionDrawerMode: NetworkDescriptionMode;
  descriptionDrawerDescrType: NetworkDescrType;
  descriptionDrawerDescriptionId: number | null;
  descriptionDrawerForm: NetworkDescriptionForm;
  descriptionDrawerSaving: boolean;
  descriptionDrawerError: string | null;
  activeDescriptionTab: NetworkDescriptionTab;
  deleteDescriptionDialogOpen: boolean;
  deleteDescriptionTarget: Network['descriptions'][number] | null;
  deleteDescriptionSubmitting: boolean;
  deleteDescriptionError: string | null;
  deleteDialogOpen: boolean;
  deleteInProgress: boolean;
  menuAnchorEl: HTMLElement | null;
  copyStatus: string | null;
  editDrawerOpen: boolean;
  editForm: NetworkEditForm | null;
  editInProgress: boolean;
  editError: string | null;
};

export type DisplayNetworkStatus = {
  label: string;
  tone: 'success' | 'warning';
};

export const EMPTY_STATE: NetworkDetailsNeoPageState = {
  network: null,
  callsignCount: null,
  currentUser: null,
  units: [],
  posts: [],
  aors: [],
  modulations: [],
  loading: true,
  referenceLoading: true,
  error: null,
  referenceWarning: null,
  callsignWarning: null,
  expandedDescriptionIds: [],
  descriptionDrawerOpen: false,
  descriptionDrawerMode: 'create',
  descriptionDrawerDescrType: 'Confirmation',
  descriptionDrawerDescriptionId: null,
  descriptionDrawerForm: {
    description: '',
    networkFreqId: null,
  },
  descriptionDrawerSaving: false,
  descriptionDrawerError: null,
  activeDescriptionTab: 'justifications',
  deleteDescriptionDialogOpen: false,
  deleteDescriptionTarget: null,
  deleteDescriptionSubmitting: false,
  deleteDescriptionError: null,
  deleteDialogOpen: false,
  deleteInProgress: false,
  menuAnchorEl: null,
  copyStatus: null,
  editDrawerOpen: false,
  editForm: null,
  editInProgress: false,
  editError: null,
};

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  if (typeof error === 'string' && error.trim() !== '') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

export function normalizeLookupName(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? fallback : trimmed;
}

export function formatClassicNetworkHeaderName(networkName: string | null | undefined, unitNames: string[]): string {
  const name = networkName?.trim() ?? '';
  const units = unitNames.map((unitName) => unitName.trim()).filter((unitName) => unitName !== '');

  if (name === '' && units.length === 0) {
    return '—';
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
      return normalizeLookupName(kind, '—');
  }
}

export function formatNetworkFreqRange(freqs: Array<Network['freqs'][number]>): string {
  const kinds = [...new Set(freqs.map((freq) => displayNetworkType(freq.kind)).filter((kind) => kind !== '—'))];
  return kinds.length === 0 ? '—' : kinds.join(', ');
}

export function formatTransferTypeLabel(freqs: Array<Network['freqs'][number]>, modulationsById: Map<number, string>): string {
  const labels = freqs
    .map((freq) => freq.modulationId)
    .filter((modulationId): modulationId is number => modulationId !== null && modulationId !== undefined)
    .map((modulationId) => modulationsById.get(modulationId) ?? `#${modulationId}`)
    .filter((label) => label.trim() !== '');

  const uniqueLabels = [...new Set(labels)];
  return uniqueLabels.length === 0 ? '—' : uniqueLabels.join(', ');
}

export function buildLookupMap<T extends { id: number; name: string }>(items: T[]): Map<number, string> {
  return new Map(items.map((item) => [item.id, item.name]));
}

export function canDeleteNetwork(user: User | null): boolean {
  const roles = new Set(user?.roles ?? []);
  return roles.has('Admin') || roles.has('UnitsEditor');
}

export function canEditNetwork(user: User | null): boolean {
  const roles = new Set(user?.roles ?? []);
  return roles.has('Admin') || roles.has('UnitsEditor');
}

export function canManageDescriptions(user: User | null): boolean {
  const roles = new Set(user?.roles ?? []);
  return roles.has('Admin') || (roles.has('UnitsEditor') && (roles.has('Rer') || roles.has('Full')));
}

export function sortDescriptionsByCreatedAtDesc(descriptions: Network['descriptions']): Network['descriptions'] {
  return [...descriptions].sort((left, right) => right.createdAt - left.createdAt);
}

export function toNetworkDescriptionForm(description: string, networkFreqId: number | null): NetworkDescriptionForm {
  return {
    description,
    networkFreqId,
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
