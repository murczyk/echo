import { PalitraDetails } from './palitra-types';

export type AnalysisMapFeaturesState = {
  palitras: boolean;
  kmz: boolean;
  pelengs: boolean;
};

export type AnalysisMapStoredState = {
  features: AnalysisMapFeaturesState;
  visiblePalitraIds: number[];
  visiblePalitraIdsNamespace: VisiblePalitraIdsNamespace;
};

type VisiblePalitraIdsNamespace = 'legacy_palitra_id' | 'geometry_id';

const DEFAULT_FEATURES_STATE: AnalysisMapFeaturesState = {
  palitras: true,
  kmz: true,
  pelengs: true
};

const DEFAULT_STATE: AnalysisMapStoredState = {
  features: DEFAULT_FEATURES_STATE,
  visiblePalitraIds: [],
  visiblePalitraIdsNamespace: 'geometry_id'
};

export class AnalysisMapStateStore {
  private state: AnalysisMapStoredState;

  constructor(private storageKey = 'analysis-map-state') {
    this.state = loadStoredState(this.storageKey);
  }

  getState(): AnalysisMapStoredState {
    return this.state;
  }

  setFeatures(partial: Partial<AnalysisMapFeaturesState>): AnalysisMapStoredState {
    const next: AnalysisMapStoredState = {
      ...this.state,
      features: {
        ...this.state.features,
        ...partial
      }
    };
    return this.commit(next);
  }

  setVisiblePalitraIds(ids: number[]): AnalysisMapStoredState {
    const next: AnalysisMapStoredState = {
      ...this.state,
      visiblePalitraIds: normalizeVisibleIds(ids),
      visiblePalitraIdsNamespace: 'geometry_id'
    };
    return this.commit(next);
  }

  toggleVisiblePalitraId(palitraId: number): AnalysisMapStoredState {
    const visibleIds = this.state.visiblePalitraIds;
    const nextVisible = visibleIds.includes(palitraId)
      ? visibleIds.filter(id => id !== palitraId)
      : [palitraId, ...visibleIds];
    return this.commit({
      ...this.state,
      visiblePalitraIds: nextVisible,
      visiblePalitraIdsNamespace: 'geometry_id'
    });
  }

  syncVisiblePalitraIds(palitras: PalitraDetails[], palitrasLoaded: boolean): AnalysisMapStoredState {
    if (!palitrasLoaded) {
      return this.state;
    }

    if (palitras.length === 0) {
      if (
        this.state.visiblePalitraIds.length > 0 ||
        this.state.visiblePalitraIdsNamespace !== 'geometry_id'
      ) {
        return this.commit({
          ...this.state,
          visiblePalitraIds: [],
          visiblePalitraIdsNamespace: 'geometry_id',
        });
      }
      return this.state;
    }

    const existingIds = new Set(palitras.map(palitraDetails => palitraDetails.palitra.id));
    let visibleIds = this.state.visiblePalitraIds;
    let namespace = this.state.visiblePalitraIdsNamespace;

    if (namespace === 'legacy_palitra_id') {
      const geometryIdsByApiPalitraId = new Map<number, number[]>();
      palitras.forEach((palitraDetails) => {
        const apiPalitraId = palitraDetails.palitra.api_palitra_id;
        if (typeof apiPalitraId !== 'number') {
          return;
        }

        const list = geometryIdsByApiPalitraId.get(apiPalitraId) ?? [];
        list.push(palitraDetails.palitra.id);
        geometryIdsByApiPalitraId.set(apiPalitraId, list);
      });

      const migrated: number[] = [];
      const seen = new Set<number>();
      this.state.visiblePalitraIds.forEach((storedId) => {
        const mappedGeometryIds = geometryIdsByApiPalitraId.get(storedId);
        if (mappedGeometryIds && mappedGeometryIds.length > 0) {
          mappedGeometryIds.forEach((geometryId) => {
            if (!seen.has(geometryId)) {
              seen.add(geometryId);
              migrated.push(geometryId);
            }
          });
          return;
        }

        if (existingIds.has(storedId) && !seen.has(storedId)) {
          seen.add(storedId);
          migrated.push(storedId);
        }
      });

      visibleIds = migrated;
      namespace = 'geometry_id';
    }

    const filtered = visibleIds.filter(id => existingIds.has(id));
    if (
      arraysEqual(filtered, this.state.visiblePalitraIds) &&
      namespace === this.state.visiblePalitraIdsNamespace
    ) {
      return this.state;
    }
    return this.commit({
      ...this.state,
      visiblePalitraIds: filtered,
      visiblePalitraIdsNamespace: namespace,
    });
  }

  private commit(next: AnalysisMapStoredState): AnalysisMapStoredState {
    if (!stateEquals(this.state, next)) {
      this.state = next;
      saveStoredState(this.storageKey, next);
    }
    return this.state;
  }
}

function loadStoredState(storageKey: string): AnalysisMapStoredState {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) {
      return DEFAULT_STATE;
    }
    const parsed = JSON.parse(stored);
    return {
      features: parseFeaturesState(parsed?.features),
      visiblePalitraIds: parseVisiblePalitraIds(parsed?.visiblePalitraIds),
      visiblePalitraIdsNamespace: parseVisiblePalitraIdsNamespace(parsed?.visiblePalitraIdsNamespace)
    };
  } catch (e) {
    console.warn('[AnalysisMap] Failed to load state, using defaults:', e);
    return DEFAULT_STATE;
  }
}

function saveStoredState(storageKey: string, state: AnalysisMapStoredState): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch (e) {
    console.warn('[AnalysisMap] Failed to save state:', e);
  }
}

function parseFeaturesState(input: unknown): AnalysisMapFeaturesState {
  const record = isRecord(input) ? input : {};
  return {
    palitras: readBool(record, 'palitras', DEFAULT_FEATURES_STATE.palitras),
    kmz: readBool(record, 'kmz', DEFAULT_FEATURES_STATE.kmz),
    pelengs: readBool(record, 'pelengs', DEFAULT_FEATURES_STATE.pelengs)
  };
}

function parseVisiblePalitraIds(input: unknown): number[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<number>();
  const result: number[] = [];
  input.forEach((value) => {
    if (typeof value === 'number' && Number.isFinite(value) && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  });
  return result;
}

function normalizeVisibleIds(input: number[]): number[] {
  return parseVisiblePalitraIds(input);
}

function parseVisiblePalitraIdsNamespace(input: unknown): VisiblePalitraIdsNamespace {
  if (input === 'geometry_id' || input === 'legacy_palitra_id') {
    return input;
  }
  return 'legacy_palitra_id';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object' && !Array.isArray(input);
}

function readBool(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === 'boolean' ? value : fallback;
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

function featuresEqual(a: AnalysisMapFeaturesState, b: AnalysisMapFeaturesState): boolean {
  return a.palitras === b.palitras && a.kmz === b.kmz && a.pelengs === b.pelengs;
}

function stateEquals(a: AnalysisMapStoredState, b: AnalysisMapStoredState): boolean {
  return (
    featuresEqual(a.features, b.features) &&
    arraysEqual(a.visiblePalitraIds, b.visiblePalitraIds) &&
    a.visiblePalitraIdsNamespace === b.visiblePalitraIdsNamespace
  );
}
