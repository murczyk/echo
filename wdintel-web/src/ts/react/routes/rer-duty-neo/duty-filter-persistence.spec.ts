/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  isDutyFilterPersistenceDisabled,
  persistDutyFilterState,
  readPersistedDutyFilterState,
  setDutyFilterPersistenceDisabled,
} from './duty-filter-persistence';

describe('Duty filter persistence', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
  });

  it('keeps the current filter until persistence is disabled', () => {
    const state = { messageFeeds: [['mf-0', { groupsSelected: ['group-a'] }]] };

    expect(persistDutyFilterState(state)).toEqual({ ok: true });
    expect(readPersistedDutyFilterState()).toEqual(state);

    expect(setDutyFilterPersistenceDisabled(true)).toEqual({ ok: true });
    expect(isDutyFilterPersistenceDisabled()).toBe(true);
    expect(readPersistedDutyFilterState()).toBeNull();
    expect(persistDutyFilterState(state)).toEqual({ ok: true });
    expect(readPersistedDutyFilterState()).toBeNull();
  });
});
