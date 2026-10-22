import type { Login } from '../../../../Bindings';

export enum AccountStatus {
  Active = 'active',
  Admin = 'admin',
  Inactive = 'inactive',
  Organism = 'organism',
  Unknown = 'unknown',
}

export enum Recency {
  Recent = 'recent',
  Aging = 'aging',
  Stale = 'stale',
  Missing = 'missing',
  Invalid = 'invalid',
}

export type CountRow = { id: string; label: string; count: number };

const KPI_DAY_MS = 24 * 60 * 60 * 1000;
export const KPI_MISSING_GROUP = 'missing';

export const statusLabels = {
  [AccountStatus.Active]: 'Активні',
  [AccountStatus.Admin]: 'Деактивовано адміністратором',
  [AccountStatus.Inactive]: 'Деактивовано через неактивність',
  [AccountStatus.Organism]: 'Організм деактивовано',
  [AccountStatus.Unknown]: 'Деактивовано: причина невідома',
} satisfies Record<AccountStatus, string>;

export const recencyLabels = {
  [Recency.Recent]: 'Менше 30 днів',
  [Recency.Aging]: 'Від 30 до 90 днів включно',
  [Recency.Stale]: 'Понад 90 днів',
  [Recency.Missing]: 'Немає запису активності',
  [Recency.Invalid]: 'Некоректна дата',
} satisfies Record<Recency, string>;

export function accountStatus(login: Login): AccountStatus {
  if (login.deleted) {
    if (login.deactivationReason === 'Admin') return AccountStatus.Admin;
    if (login.deactivationReason === 'Inactive') return AccountStatus.Inactive;
    return AccountStatus.Unknown;
  }
  return login.organismEnabled === false ? AccountStatus.Organism : AccountStatus.Active;
}

export function accountRecency(login: Login, asOf: number): Recency {
  if (login.lastActiveAt === null) return Recency.Missing;
  const age = asOf - login.lastActiveAt;
  if (!Number.isFinite(age) || age < 0 || login.lastActiveAt < 0) return Recency.Invalid;
  if (age < 30 * KPI_DAY_MS) return Recency.Recent;
  return age <= 90 * KPI_DAY_MS ? Recency.Aging : Recency.Stale;
}

export function uniqueAccounts(logins: Login[]): Login[] {
  return [...new Map(logins.map((login) => [login.id, login])).values()];
}

export function countCategories(
  logins: Login[],
  labels: Record<string, string>,
  category: (login: Login) => string,
): CountRow[] {
  const counts = new Map<string, number>();
  for (const login of logins) {
    const id = category(login);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return Object.entries(labels).map(([id, label]) => ({ id, label, count: counts.get(id) ?? 0 }));
}

export function groupAccounts(
  logins: Login[],
  groups: (login: Login) => Array<{ id: string; label: string }>,
): CountRow[] {
  const counts = new Map<string, CountRow>();
  for (const login of logins) {
    for (const { id, label } of new Map(groups(login).map((group) => [group.id, group])).values()) {
      const row = counts.get(id) ?? { id, label, count: 0 };
      row.count += 1;
      counts.set(id, row);
    }
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label, 'uk') || a.id.localeCompare(b.id),
  );
}

export function organismGroup(login: Login) {
  return {
    id: login.organismId === null ? KPI_MISSING_GROUP : String(login.organismId),
    label: login.organismName ?? 'Не вказано',
  };
}

export function roleGroups(login: Login) {
  return login.roles.length
    ? login.roles.map((role) => ({ id: role, label: role }))
    : [{ id: KPI_MISSING_GROUP, label: 'Не вказано' }];
}

export function directionGroups(login: Login) {
  return [
    {
      id: login.sigintZoneId === null ? KPI_MISSING_GROUP : String(login.sigintZoneId),
      label: login.sigintZoneName ?? 'Не вказано',
    },
  ];
}

export function formatSnapshotTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('uk-UA');
}
