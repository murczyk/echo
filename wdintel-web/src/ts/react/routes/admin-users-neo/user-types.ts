import type { Organism, SigintZone } from '../../../../Bindings';

export type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

export const ROLE_OPTIONS = [
  'Admin',
  'OrganismAdmin',
  'Api',
  'ApiAgent',
  'Rer',
  'Bpla',
  'Full',
  'Basic',
  'UnitsEditor',
  'NetworkEditor',
  'CallsignsEditor',
  'Cyber',
  'CyberViewer',
  'CyberViewerRestricted',
  'AdvancedReports',
  'DeleteMsg',
  'NoAutoLogout',
  'No2FA',
  'MessengerIngest',
  'CyberMessengers',
];

export const STATUS_FILTER_OPTIONS = [
  { text: 'Активний', value: 'Активний' },
  { text: 'Деактивовано адміністратором', value: 'Деактивовано адміністратором' },
  { text: 'Деактивовано через неактивність', value: 'Деактивовано через неактивність' },
  { text: 'Організм деактивовано', value: 'Організм деактивовано' },
  { text: 'Деактивовано', value: 'Деактивовано' },
];

export const LEGACY_STATUS_FILTER_VALUES: Record<string, string> = {
  'Видалено адміном': 'Деактивовано адміністратором',
  Неактивний: 'Деактивовано через неактивність',
  Невідомо: 'Деактивовано',
};

export const DEFAULT_COLUMNS_VISIBILITY = {
  login: true,
  id: false,
  roles: true,
  organism: true,
  aors: true,
  zone: false,
  deltaLogin: false,
  createdAt: true,
  status: true,
  description: false,
};

export const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'mrt-row-actions',
  'login',
  'id',
  'roles',
  'organism',
  'aors',
  'zone',
  'deltaLogin',
  'createdAt',
  'status',
  'description',
];

export type StatusInfo = {
  label: string;
  colorClass: string;
  details?: string[];
};

export type ZoneEntry = [number, SigintZone];
export type LookupAutocompleteOption = {
  id: number;
  label: string;
};

export type UserLookups = {
  zones: ZoneEntry[];
  zonesStatus: LoadingStatus;
  zonesError: string | null;
  organisms: Organism[];
  organismsStatus: LoadingStatus;
  organismsError: string | null;
};

export type AddUserForm = {
  login: string;
  deltaLogin: string;
  password: string;
  passwordAuthEnabled: boolean;
  roles: string[];
  sigintZoneId: number | null;
  organismId: number | null;
  signalProfileId: string | null;
  description: string;
};

export type AddUserErrors = {
  login?: string;
  deltaLogin?: string;
  password?: string;
  roles?: string;
  zone?: string;
  organism?: string;
};

export type EditUserForm = {
  id: string;
  login: string;
  password: string;
  roles: string[];
  sigintZoneId: number | null;
  organismId: number | null;
  deltaLogin: string;
  deleted: boolean;
  signalProfileId: string | null;
  description: string;
  passwordAuthEnabled: boolean;
  hasPassword: boolean;
};

export type EditUserErrors = {
  login?: string;
  password?: string;
  deltaLogin?: string;
  roles?: string;
  zone?: string;
  organism?: string;
};

export type UserField = keyof AddUserErrors;
export type UserFieldState = Partial<Record<UserField, true>>;
export type UserServerErrors = AddUserErrors & { passwordAuthEnabled?: string };
export type ParsedServerFieldErrors = {
  fields: UserServerErrors;
  fallbackMessages: string[];
  hasDiscardedEntries: boolean;
  isJson: boolean;
};

export const EMPTY_ADD_FORM: AddUserForm = {
  login: '',
  deltaLogin: '',
  password: '',
  passwordAuthEnabled: false,
  roles: ['Rer'],
  sigintZoneId: null,
  organismId: null,
  description: '',
  signalProfileId: null,
};
