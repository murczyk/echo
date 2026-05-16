import {
  AnalyzeKmzResponse,
  AreaOfResponsibility,
  CreatePalitraReq,
  MyScope,
  Organism,
  Palitra,
  PalitraAccess,
  User,
} from '../../../../Bindings';

import { AccessType, KmzColorOption, PalitraFormState } from './types';

export const DEFAULT_COLOR_HEX = '#00bcd4';

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'Невідома помилка. Спробуйте ще раз.';
}

export function isAdmin(user: User | null): boolean {
  return Boolean(user?.roles.includes('Admin'));
}

export function isEditor(user: User | null): boolean {
  if (!user) return false;
  return user.roles.includes('UnitsEditor') || user.roles.includes('CallsignsEditor');
}

export function isRer(user: User | null): boolean {
  return Boolean(user?.roles.some((role) => role === 'Admin' || role === 'Full' || role === 'Rer'));
}

export function canEditScopedLogins(user: User | null): boolean {
  return canManagePalitraAccess(user);
}

function canUseLoginAccess(user: User | null): boolean {
  return canManagePalitraAccess(user);
}

function canUseOrganismAccess(user: User | null, myScope: MyScope | null): boolean {
  return canManagePalitraAccess(user) && (isAdmin(user) || Boolean(myScope?.organism));
}

function canUseAorAccess(user: User | null, myScope: MyScope | null): boolean {
  return canManagePalitraAccess(user) && (isAdmin(user) || (myScope?.aorIds ?? []).length > 0);
}

function canManagePalitraAccess(user: User | null): boolean {
  return isAdmin(user) || (isRer(user) && isEditor(user));
}

export function canModifyPalitra(user: User | null, palitra: Palitra): boolean {
  return isAdmin(user) || (canManagePalitraAccess(user) && palitra.author === user?.name);
}

export function getAvailableAccessTypes(user: User | null, myScope: MyScope | null): AccessType[] {
  return [
    ...(canUseLoginAccess(user) ? (['logins'] as AccessType[]) : []),
    ...(canUseOrganismAccess(user, myScope) ? (['organisms'] as AccessType[]) : []),
    ...(canUseAorAccess(user, myScope) ? (['aor'] as AccessType[]) : []),
  ];
}

export function isAccessRestricted(user: User | null): boolean {
  return !isAdmin(user);
}

export function normalizeLogins(logins: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const login of logins) {
    const value = login.trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

export function toPalitraAccess(form: PalitraFormState): PalitraAccess {
  if (form.accessType === 'logins') {
    return { ByLogins: { logins: normalizeLogins(form.logins) } };
  }

  if (form.accessType === 'organisms') {
    return { ByOrganisms: { organismIds: form.organismIds } };
  }

  return { ByAor: { aorIds: form.aorIds } };
}

export function toCreateReq(form: PalitraFormState): CreatePalitraReq {
  return {
    name: form.name,
    colorHex: form.colorHex,
    access: toPalitraAccess(form),
    sourceFileName: null,
    lastUploadedAtTs: null,
  };
}

export function getInitialCreateForm(user: User | null, myScope: MyScope | null): PalitraFormState {
  const available = getAvailableAccessTypes(user, myScope);
  const defaultOrganismIds = myScope?.organism ? [myScope.organism.id] : [];
  const defaultAccessType =
    defaultOrganismIds.length > 0 && available.includes('organisms') ? 'organisms' : (available[0] ?? 'logins');

  if (isAdmin(user)) {
    return {
      name: '',
      colorHex: DEFAULT_COLOR_HEX,
      accessType: defaultAccessType,
      logins: [],
      organismIds: defaultOrganismIds,
      aorIds: [],
    };
  }

  return {
    name: '',
    colorHex: DEFAULT_COLOR_HEX,
    accessType: defaultAccessType,
    logins: available.includes('logins') && user?.name ? [user.name] : [],
    organismIds: available.includes('organisms') ? defaultOrganismIds : [],
    aorIds: available.includes('aor') ? myScope?.aorIds ?? [] : [],
  };
}

export function withDefaultOrganismAccess(
  form: PalitraFormState,
  accessType: AccessType,
  myScope: MyScope | null,
): PalitraFormState {
  if (accessType !== 'organisms') return { ...form, accessType };
  if (form.organismIds.length > 0) return { ...form, accessType };
  if (!myScope?.organism) return { ...form, accessType };

  return {
    ...form,
    accessType,
    organismIds: [myScope.organism.id],
  };
}

export function palitraToForm(palitra: Palitra): PalitraFormState {
  if (palitra.accessLogins.length > 0) {
    return {
      name: palitra.name,
      colorHex: palitra.colorHex,
      accessType: 'logins',
      logins: [...palitra.accessLogins],
      organismIds: [],
      aorIds: [],
    };
  }

  if (palitra.accessOrganismIds.length > 0) {
    return {
      name: palitra.name,
      colorHex: palitra.colorHex,
      accessType: 'organisms',
      logins: [],
      organismIds: [...palitra.accessOrganismIds],
      aorIds: [],
    };
  }

  return {
    name: palitra.name,
    colorHex: palitra.colorHex,
    accessType: 'aor',
    logins: [],
    organismIds: [],
    aorIds: [...palitra.accessAorId],
  };
}

export function buildPalitraNameWithSuffix(baseName: string, suffix: string): string {
  const normalizedBaseName = baseName.trim();
  const normalizedSuffix = suffix.trim();
  if (!normalizedSuffix) return normalizedBaseName;
  return normalizedBaseName + ' ' + normalizedSuffix;
}

export function kmzColorOptionsFromAnalysis(analysis: AnalyzeKmzResponse): KmzColorOption[] {
  return analysis.topColors.map((color, index) => ({
    rank: index + 1,
    colorHex: color.colorHex,
    count: color.count,
    selected: true,
    suffix: color.suggestedSuffix?.trim() ?? '',
  }));
}

export function isFormValid(form: PalitraFormState): boolean {
  if (!form.name.trim()) return false;

  if (form.accessType === 'logins') return form.logins.length > 0;
  if (form.accessType === 'organisms') return form.organismIds.length > 0;
  return form.aorIds.length > 0;
}

export function getAccessSummary(
  palitra: Palitra,
  user: User | null,
  myScope: MyScope | null,
  organisms: Organism[],
  aors: AreaOfResponsibility[],
): string {
  const admin = isAdmin(user);
  const isAuthor = palitra.author === user?.name;
  if (!admin && !isAuthor) return '—';

  if (palitra.accessLogins.length > 0) return 'Логіни: ' + palitra.accessLogins.join(', ');

  if (palitra.accessOrganismIds.length > 0) {
    if (admin) {
      const names = palitra.accessOrganismIds
        .map((id) => organisms.find((organism) => organism.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      return names.length > 0 ? 'Підрозділи: ' + names.join(', ') : 'Підрозділи: ' + palitra.accessOrganismIds.join(', ');
    }

    const name = myScope?.organism?.name;
    return name ? 'Підрозділи: ' + name : 'Підрозділи: —';
  }

  if (palitra.accessAorId.length > 0) {
    if (admin) {
      const names = palitra.accessAorId
        .map((id) => aors.find((aor) => aor.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      return names.length > 0 ? 'Смуги: ' + names.join(', ') : 'Смуги: ' + palitra.accessAorId.join(', ');
    }

    const allowed = new Set(myScope?.aorIds ?? []);
    const names = palitra.accessAorId
      .filter((id) => allowed.has(id))
      .map((id) => myScope?.aors.find((aor) => aor.id === id)?.name ?? String(id));
    return names.length > 0 ? 'Смуги: ' + names.join(', ') : 'Смуги: —';
  }

  return 'без доступу';
}

export function applyRestrictedAccess(
  form: PalitraFormState,
  user: User | null,
  myScope: MyScope | null,
  allowedLogins: string[] = [],
): PalitraFormState {
  if (!isAccessRestricted(user)) return form;

  if (form.accessType === 'logins') {
    if (!canUseLoginAccess(user)) {
      return {
        ...form,
        logins: [],
      };
    }

    if (canEditScopedLogins(user)) {
      const fallbackLogin = user?.name?.trim() ?? '';
      const allowedSet = new Set(normalizeLogins([fallbackLogin, ...allowedLogins]));
      const filteredLogins = normalizeLogins(form.logins.filter((login) => allowedSet.has(login)));

      return {
        ...form,
        logins: filteredLogins.length > 0 ? filteredLogins : (fallbackLogin ? [fallbackLogin] : []),
      };
    }

    return {
      ...form,
      logins: user?.name ? [user.name] : [],
    };
  }

  if (form.accessType === 'organisms') {
    if (!canUseOrganismAccess(user, myScope)) {
      return {
        ...form,
        organismIds: [],
      };
    }

    return {
      ...form,
      organismIds: myScope?.organism ? [myScope.organism.id] : [],
    };
  }

  if (!canUseAorAccess(user, myScope)) {
    return {
      ...form,
      aorIds: [],
    };
  }

  const allowedAorIds = new Set(myScope?.aorIds ?? []);
  const scopedAorIds = myScope?.aorIds ?? [];
  const selectedScopedAorIds = form.aorIds.filter((id) => allowedAorIds.has(id));

  return {
    ...form,
    aorIds: selectedScopedAorIds.length > 0 ? selectedScopedAorIds : scopedAorIds,
  };
}

export function accessTypeLabel(accessType: AccessType): string {
  if (accessType === 'logins') return 'Логіни';
  if (accessType === 'organisms') return 'Підрозділи';
  return 'Смуги';
}
