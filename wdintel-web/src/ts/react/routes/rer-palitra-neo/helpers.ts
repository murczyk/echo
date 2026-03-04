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

export function getAvailableAccessTypes(user: User | null, myScope: MyScope | null): AccessType[] {
  const admin = isAdmin(user);
  const editor = isEditor(user);
  const hasOrganism = Boolean(myScope?.organism);
  const hasAorIds = (myScope?.aorIds ?? []).length > 0;

  return [
    'logins',
    ...(admin || hasOrganism ? (['organisms'] as AccessType[]) : []),
    ...(admin || (editor && hasAorIds) ? (['aor'] as AccessType[]) : []),
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
  const defaultAccessType = available[0] ?? 'logins';

  if (isAdmin(user)) {
    return {
      name: '',
      colorHex: DEFAULT_COLOR_HEX,
      accessType: defaultAccessType,
      logins: [],
      organismIds: [],
      aorIds: [],
    };
  }

  return {
    name: '',
    colorHex: DEFAULT_COLOR_HEX,
    accessType: defaultAccessType,
    logins: user?.name ? [user.name] : [],
    organismIds: myScope?.organism ? [myScope.organism.id] : [],
    aorIds: myScope?.aorIds ?? [],
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
  return `${normalizedBaseName} ${normalizedSuffix}`;
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

  if (palitra.accessLogins.length > 0) return `Логіни: ${palitra.accessLogins.join(', ')}`;

  if (palitra.accessOrganismIds.length > 0) {
    if (admin) {
      const names = palitra.accessOrganismIds
        .map((id) => organisms.find((organism) => organism.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      return names.length > 0 ? `Підрозділи: ${names.join(', ')}` : `Підрозділи: ${palitra.accessOrganismIds.join(', ')}`;
    }

    const name = myScope?.organism?.name;
    return name ? `Підрозділи: ${name}` : 'Підрозділи: —';
  }

  if (palitra.accessAorId.length > 0) {
    if (admin) {
      const names = palitra.accessAorId
        .map((id) => aors.find((aor) => aor.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      return names.length > 0 ? `Смуги: ${names.join(', ')}` : `Смуги: ${palitra.accessAorId.join(', ')}`;
    }

    const allowed = new Set(myScope?.aorIds ?? []);
    const names = palitra.accessAorId
      .filter((id) => allowed.has(id))
      .map((id) => myScope?.aors.find((aor) => aor.id === id)?.name ?? String(id));
    return names.length > 0 ? `Смуги: ${names.join(', ')}` : 'Смуги: —';
  }

  return 'без доступу';
}

export function applyRestrictedAccess(form: PalitraFormState, user: User | null, myScope: MyScope | null): PalitraFormState {
  if (!isAccessRestricted(user)) return form;

  if (form.accessType === 'logins') {
    return {
      ...form,
      logins: user?.name ? [user.name] : [],
    };
  }

  if (form.accessType === 'organisms') {
    return {
      ...form,
      organismIds: myScope?.organism ? [myScope.organism.id] : [],
    };
  }

  const allowedAorIds = new Set(myScope?.aorIds ?? []);

  return {
    ...form,
    aorIds: form.aorIds.filter((id) => allowedAorIds.has(id)),
  };
}

export function accessTypeLabel(accessType: AccessType): string {
  if (accessType === 'logins') return 'Логіни';
  if (accessType === 'organisms') return 'Підрозділи';
  return 'Смуги';
}

export function normalizeSortableValue(value: string | null | undefined): string {
  return (value ?? '').toLocaleLowerCase('uk-UA');
}

export function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, 'uk-UA');
}
