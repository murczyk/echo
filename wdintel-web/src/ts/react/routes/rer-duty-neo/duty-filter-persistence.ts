const DUTY_FILTER_STATE_STORAGE_KEY = 'rer-duty-neo-current-filter';
const DUTY_FILTER_PERSISTENCE_DISABLED_STORAGE_KEY =
  'rer-duty-neo-current-filter-persistence-disabled';

export type DutyFilterStorageResult = { ok: true } | { ok: false; error: string };

function storageError(error: unknown): DutyFilterStorageResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function isDutyFilterPersistenceDisabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DUTY_FILTER_PERSISTENCE_DISABLED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function readPersistedDutyFilterState(): unknown | null {
  if (typeof window === 'undefined' || isDutyFilterPersistenceDisabled()) return null;
  try {
    const raw = window.localStorage.getItem(DUTY_FILTER_STATE_STORAGE_KEY);
    return raw == null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function persistDutyFilterState(state: unknown): DutyFilterStorageResult {
  if (typeof window === 'undefined') return { ok: true };
  try {
    if (isDutyFilterPersistenceDisabled()) {
      window.localStorage.removeItem(DUTY_FILTER_STATE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(DUTY_FILTER_STATE_STORAGE_KEY, JSON.stringify(state));
    }
    return { ok: true };
  } catch (error) {
    return storageError(error);
  }
}

export function clearPersistedDutyFilterState(): DutyFilterStorageResult {
  if (typeof window === 'undefined') return { ok: true };
  try {
    window.localStorage.removeItem(DUTY_FILTER_STATE_STORAGE_KEY);
    return { ok: true };
  } catch (error) {
    return storageError(error);
  }
}

export function setDutyFilterPersistenceDisabled(disabled: boolean): DutyFilterStorageResult {
  if (typeof window === 'undefined') return { ok: true };
  try {
    if (disabled) {
      window.localStorage.setItem(DUTY_FILTER_PERSISTENCE_DISABLED_STORAGE_KEY, 'true');
      window.localStorage.removeItem(DUTY_FILTER_STATE_STORAGE_KEY);
    } else {
      window.localStorage.removeItem(DUTY_FILTER_PERSISTENCE_DISABLED_STORAGE_KEY);
    }
    return { ok: true };
  } catch (error) {
    return storageError(error);
  }
}
