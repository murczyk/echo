import type {
  AreaOfResponsibility,
  ModulationRec,
  Network,
  NetworkDescrType,
  NetworkPoint,
  NetworkStatus,
  NetworkFreqsRes,
  Post,
  NetworkCallsign,
  NetworkCallsignRes,
  Source,
  Unit,
  User,
} from '../../../../Bindings';
import type { NetworkFreqActivityByFreq } from './frequency-utils';
import type {
  NetworkCallsignCatalogGroupView,
  NetworkCallsignActivityMap,
  NetworkCallsignDrawerForm,
  NetworkCallsignDrawerMode,
  NetworkCallsignInterceptedView,
  NetworkCallsignRowView,
  NetworkCallsignSectionMode,
  NetworkCallsignStatusFilter,
} from './network-callsigns';

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
  topic: string;
  description: string;
  networkFreqId: number | null;
};

export type NetworkOption = {
  id: number;
  label: string;
};

export type NetworkDescriptionMode = 'create' | 'edit';

export type NetworkDetailsTab = 'descriptions' | 'signs' | 'frequencies' | 'callsigns' | 'activity' | 'pelengation';

export type NetworkFreqCreateWizardForm = {
  freq: string;
  kind: 'DMR' | 'DMRe' | 'NFM';
  modulationId: number | null;
  description: string;
  activeFrom: string;
  activeTo: string;
  encryptionKeyIds: number[];
};

export type NetworkFreqEditForm = {
  networkFreqId: number;
  kind: 'DMR' | 'DMRe' | 'NFM';
  modulationId: number | null;
  activeFrom: string;
  activeTo: string;
};

export type NetworkFreqTechDataForm = {
  networkFreqId: number;
  encryptionKeyIds: number[];
};

export const FREQUENCY_FORMAT_ERROR = 'Невірний формат частоти (наприклад: 146.5000)';

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

export type NetworkDetailsNeoPageState = {
  network: Network | null;
  sources: Source[];
  freqs: NetworkFreqsRes[];
  freqsLoaded: boolean;
  freqsLoading: boolean;
  freqsError: string | null;
  freqActivityByFreq: NetworkFreqActivityByFreq;
  networkActivity: Record<string, Record<string, number>>;
  networkActivityLoaded: boolean;
  networkActivityLoading: boolean;
  networkActivityError: string | null;
  pelengPoints: NetworkPoint[];
  pelengPointsLoaded: boolean;
  pelengPointsLoading: boolean;
  pelengPointsError: string | null;
  pelengPointsRequestedFrom: number | null;
  pelengPointsRequestedTo: number | null;
  callsignCount: number | null;
  networkCallsigns: NetworkCallsign[];
  networkCallsignGroups: NetworkCallsignRes[];
  callsignActivityMap: NetworkCallsignActivityMap;
  catalogCallsignGroups: NetworkCallsignCatalogGroupView[];
  unknownInterceptedCallsigns: NetworkCallsignInterceptedView[];
  callsignsLoaded: boolean;
  callsignsLoading: boolean;
  callsignsError: string | null;
  callsignStatusFilter: NetworkCallsignStatusFilter;
  callsignSectionMode: NetworkCallsignSectionMode;
  callsignInterceptedExpanded: boolean;
  callsignCreateInFlightCallsigns: string[];
  callsignCatalogAddInFlightIds: number[];
  callsignUpdateInFlightIds: number[];
  callsignDeleteInFlightIds: number[];
  currentUser: User | null;
  units: Unit[];
  posts: Post[];
  aors: AreaOfResponsibility[];
  modulations: ModulationRec[];
  callsignDrawerOpen: boolean;
  callsignDrawerMode: NetworkCallsignDrawerMode;
  callsignDrawerForm: NetworkCallsignDrawerForm | null;
  callsignDrawerSaving: boolean;
  callsignDrawerError: string | null;
  callsignDeleteDialogOpen: boolean;
  callsignDeleteTarget: NetworkCallsignRowView | null;
  callsignDeleteSubmitting: boolean;
  callsignDeleteError: string | null;
  loading: boolean;
  referenceLoading: boolean;
  error: string | null;
  referenceWarning: string | null;
  callsignWarning: string | null;
  expandedDescriptionIds: number[];
  activeNetworkDetailsTab: NetworkDetailsTab;
  descriptionDrawerOpen: boolean;
  descriptionDrawerMode: NetworkDescriptionMode;
  descriptionDrawerDescrType: NetworkDescrType;
  descriptionDrawerDescriptionId: number | null;
  descriptionDrawerForm: NetworkDescriptionForm;
  descriptionDrawerSaving: boolean;
  descriptionDrawerError: string | null;
  deleteDescriptionDialogOpen: boolean;
  deleteDescriptionTarget: Network['descriptions'][number] | null;
  deleteDescriptionSubmitting: boolean;
  deleteDescriptionError: string | null;
  expandedFrequencyGroupIds: string[];
  freqRowActionMenuAnchorEl: HTMLElement | null;
  freqRowActionTargetId: number | null;
  freqCreateWizardOpen: boolean;
  freqCreateWizardStep: 1 | 2;
  freqCreateWizardForm: NetworkFreqCreateWizardForm;
  freqCreateWizardSaving: boolean;
  freqCreateWizardError: string | null;
  freqEditDrawerOpen: boolean;
  freqEditDrawerForm: NetworkFreqEditForm | null;
  freqEditDrawerSaving: boolean;
  freqEditDrawerError: string | null;
  freqTechDrawerOpen: boolean;
  freqTechDrawerForm: NetworkFreqTechDataForm | null;
  freqTechDrawerSaving: boolean;
  freqTechDrawerError: string | null;
  freqDeleteDialogOpen: boolean;
  freqDeleteTarget: NetworkFreqsRes | null;
  freqDeleteSubmitting: boolean;
  freqDeleteError: string | null;
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
  sources: [],
  freqs: [],
  freqsLoaded: false,
  freqsLoading: false,
  freqsError: null,
  freqActivityByFreq: {},
  networkActivity: {},
  networkActivityLoaded: false,
  networkActivityLoading: false,
  networkActivityError: null,
  pelengPoints: [],
  pelengPointsLoaded: false,
  pelengPointsLoading: false,
  pelengPointsError: null,
  pelengPointsRequestedFrom: null,
  pelengPointsRequestedTo: null,
  callsignCount: null,
  networkCallsigns: [],
  networkCallsignGroups: [],
  callsignActivityMap: new Map(),
  catalogCallsignGroups: [],
  unknownInterceptedCallsigns: [],
  callsignsLoaded: false,
  callsignsLoading: false,
  callsignsError: null,
  callsignStatusFilter: 'All',
  callsignSectionMode: 'network',
  callsignInterceptedExpanded: false,
  callsignCreateInFlightCallsigns: [],
  callsignCatalogAddInFlightIds: [],
  callsignUpdateInFlightIds: [],
  callsignDeleteInFlightIds: [],
  currentUser: null,
  units: [],
  posts: [],
  aors: [],
  modulations: [],
  callsignDrawerOpen: false,
  callsignDrawerMode: 'create',
  callsignDrawerForm: null,
  callsignDrawerSaving: false,
  callsignDrawerError: null,
  callsignDeleteDialogOpen: false,
  callsignDeleteTarget: null,
  callsignDeleteSubmitting: false,
  callsignDeleteError: null,
  loading: true,
  referenceLoading: true,
  error: null,
  referenceWarning: null,
  callsignWarning: null,
  expandedDescriptionIds: [],
  activeNetworkDetailsTab: 'descriptions',
  descriptionDrawerOpen: false,
  descriptionDrawerMode: 'create',
  descriptionDrawerDescrType: 'Confirmation',
  descriptionDrawerDescriptionId: null,
  descriptionDrawerForm: {
    topic: '',
    description: '',
    networkFreqId: null,
  },
  descriptionDrawerSaving: false,
  descriptionDrawerError: null,
  deleteDescriptionDialogOpen: false,
  deleteDescriptionTarget: null,
  deleteDescriptionSubmitting: false,
  deleteDescriptionError: null,
  expandedFrequencyGroupIds: [],
  freqRowActionMenuAnchorEl: null,
  freqRowActionTargetId: null,
  freqCreateWizardOpen: false,
  freqCreateWizardStep: 1,
  freqCreateWizardForm: {
    freq: '',
    kind: 'DMR',
    modulationId: null,
    description: '',
    activeFrom: '',
    activeTo: '',
    encryptionKeyIds: [],
  },
  freqCreateWizardSaving: false,
  freqCreateWizardError: null,
  freqEditDrawerOpen: false,
  freqEditDrawerForm: null,
  freqEditDrawerSaving: false,
  freqEditDrawerError: null,
  freqTechDrawerOpen: false,
  freqTechDrawerForm: null,
  freqTechDrawerSaving: false,
  freqTechDrawerError: null,
  freqDeleteDialogOpen: false,
  freqDeleteTarget: null,
  freqDeleteSubmitting: false,
  freqDeleteError: null,
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

export function canManageNetworkCallsignActions(user: User | null): boolean {
  const roles = new Set(user?.roles ?? []);
  return roles.has('Admin') || (roles.has('UnitsEditor') && (roles.has('Rer') || roles.has('Full')));
}

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

export function formatDateInputValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

export function typeLabelFromKind(kind: string | null | undefined): 'DMR' | 'DMRe' | 'NFM' {
  const normalized = kind?.trim().toUpperCase() ?? '';
  if (normalized === 'DMR') return 'DMR';
  if (normalized === 'DMRE') return 'DMRe';
  return 'NFM';
}

export function parseNetworkDetailsDateInput(value: string): number | null {
  const text = value.trim();
  if (text === '') return null;
  const parsed = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}
