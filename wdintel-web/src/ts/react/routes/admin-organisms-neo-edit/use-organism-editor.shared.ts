import {
  AreaOfResponsibility,
  Organism,
  OrganismGroup,
  SignalGroupFull,
} from '../../../../Bindings';
import { GOI_INTEGRATION_TYPE_FULL, type GoiIntegrationType } from '../../services/api/organisms';
export type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';
export type StatusMessage = { kind: 'error' | 'success'; message: string } | null;
export type OrganismEditTab = 'main' | 'tags' | 'goi' | 'users' | 'labels';

export type OrganismFormState = {
  name: string;
  parentId: number | null;
  roles: string[];
  aorIds: number[];
  enabled: boolean;
  limitGroups: boolean;
  groupIds: string[];
  goiIntegrationType: GoiIntegrationType;
  goiSshHost: string;
  goiSshUser: string;
  goiSshPort: number;
  goiPath: string;
  goiApiHost: string;
  goiApiPort: number;
  goiApiLogin: string;
  goiApiPassword: string;
  goiSimpleUrl: string;
  goiSimpleUrlDirty: boolean;
};

export const GOI_SSH_PORT_DEFAULT = 22;
export const GOI_API_PORT_DEFAULT = 8088;
export const GOI_PATH_DEFAULT = '/etc/goi/data/palettes';

export const ROLE_OPTIONS = [
  'Admin',
  'OrganismAdmin',
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
];

export const emptyFormState: OrganismFormState = {
  name: '',
  parentId: null,
  roles: [],
  aorIds: [],
  enabled: true,
  limitGroups: false,
  groupIds: [],
  goiIntegrationType: GOI_INTEGRATION_TYPE_FULL,
  goiSshHost: '',
  goiSshUser: '',
  goiSshPort: GOI_SSH_PORT_DEFAULT,
  goiPath: GOI_PATH_DEFAULT,
  goiApiHost: '',
  goiApiPort: GOI_API_PORT_DEFAULT,
  goiApiLogin: '',
  goiApiPassword: '',
  goiSimpleUrl: '',
  goiSimpleUrlDirty: false,
};

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

export function formatGroupLabel(group: SignalGroupFull | undefined, fallbackKey: string): string {
  if (!group) return fallbackKey;
  if (group.name && group.name.trim()) return group.name;
  return `Без назви (id=${group.masterKey.slice(0, 6)}...)`;
}

export function formatAorLabel(aor: AreaOfResponsibility | undefined, fallbackId: number): string {
  if (!aor) return String(fallbackId);
  return aor.name || String(fallbackId);
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string')
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return [];
}

export function asNumberArray(value: unknown): number[] {
  if (Array.isArray(value))
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item));
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item));
  }
  return [];
}

export function getOrganismGroupKeys(
  organismId: number,
  organismGroups: OrganismGroup[],
): string[] {
  return organismGroups
    .filter((item) => item.organismId === organismId)
    .map((item) => item.masterKey);
}

export function buildAvailableGroups(
  parentId: number | null,
  allGroups: SignalGroupFull[],
  organismGroups: OrganismGroup[],
) {
  if (!parentId) return allGroups;
  const parentGroupKeys = organismGroups
    .filter((item) => item.organismId === parentId)
    .map((item) => item.masterKey);
  if (parentGroupKeys.length === 0) return allGroups;
  const parentGroupSet = new Set(parentGroupKeys);
  return allGroups.filter((group) => parentGroupSet.has(group.masterKey));
}

export function validateGroupsForParent(
  organismGroups: OrganismGroup[],
  allGroups: SignalGroupFull[],
  selectedGroups: string[],
  parentId: number | null,
): string[] {
  if (!parentId) return [];
  const parentGroupKeys = organismGroups
    .filter((item) => item.organismId === parentId)
    .map((item) => item.masterKey);
  if (parentGroupKeys.length === 0) return [];
  const parentGroupSet = new Set(parentGroupKeys);
  return selectedGroups
    .filter((groupId) => !parentGroupSet.has(groupId))
    .map((groupId) => {
      const group = allGroups.find((item) => item.masterKey === groupId);
      return formatGroupLabel(group, groupId);
    });
}

export function getBackToPath(): string {
  const params = new URLSearchParams(window.location.search);
  const backTo = params.get('backTo');
  if (!backTo) return '/admin/organisms-neo';

  try {
    return decodeURIComponent(backTo);
  } catch (_) {
    return '/admin/organisms-neo';
  }
}

export function hasAnyGoiApiSettings(form: OrganismFormState): boolean {
  if (form.goiIntegrationType !== GOI_INTEGRATION_TYPE_FULL) return false;
  const sshHost = form.goiSshHost.trim();
  const apiHost = form.goiApiHost.trim();
  if (form.goiApiLogin.trim() || form.goiApiPassword.trim()) return true;
  return apiHost.length > 0 && apiHost !== sshHost;
}

export function getSimpleGoiUrl(apiHost: string, sshHost: string): string {
  return apiHost.trim() || sshHost.trim();
}

export type AdminOrganismsNeoEditPageProps = {
  organismId: string | null;
};

export type OrganismFormFieldsProps = {
  form: OrganismFormState;
  formErrors: Record<string, string>;
  isSubmitting: boolean;
  isCheckingGoiConnection: boolean;
  isSettingUpGoiWorker: boolean;
  isNew: boolean;
  organisms: Organism[];
  groups: SignalGroupFull[];
  availableGroups: SignalGroupFull[];
  aors: AreaOfResponsibility[];
  computedGroups: SignalGroupFull[] | null;
  computeError: string | null;
  goiConnectionStatus: StatusMessage;
  isComputing: boolean;
  groupsValidation: string[];
  onCheckGoiConnection: () => void;
  onSetupGoiWorker: () => void;
  onChange: (patch: Partial<OrganismFormState>) => void;
};
