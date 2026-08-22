/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AnalysisMapStateStore } from './analysis-map-state';

describe('AnalysisMapStateStore', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('migrates the legacy KMZ visibility preference', () => {
    const storageKey = 'analysis-map-state-test';
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        features: { palitras: true, kmz: false, pelengs: true },
        visiblePalitraIds: [],
        visiblePalitraIdsNamespace: 'geometry_id',
      }),
    );

    const store = new AnalysisMapStateStore(storageKey);

    expect(store.getState().features.deltaKml).toBe(false);
    store.setFeatures({ deltaKml: true });
    expect(JSON.parse(localStorage.getItem(storageKey) ?? '{}').features).toEqual({
      palitras: true,
      deltaKml: true,
      pelengs: true,
    });
  });
});
