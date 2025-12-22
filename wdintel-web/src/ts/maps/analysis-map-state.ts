import { PalitraDetails } from './palitra-types';

export type AnalysisMapFeaturesState = {
  palitras: boolean;
  kmz: boolean;
  pelengs: boolean;
};

export type AnalysisMapStoredState = {
  features: AnalysisMapFeaturesState;
  visiblePalitraIds: number[];
};

const DEFAULT_FEATURES_STATE: AnalysisMapFeaturesState = {
  palitras: true,
  kmz: true,
  pelengs: true
};

const DEFAULT_STATE: AnalysisMapStoredState = {
  features: DEFAULT_FEATURES_STATE,
  visiblePalitraIds: []
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
      visiblePalitraIds: normalizeVisibleIds(ids)
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
      visiblePalitraIds: nextVisible
    });
  }

  syncVisiblePalitraIds(palitras: PalitraDetails[], palitrasLoaded: boolean): AnalysisMapStoredState {
    if (!palitrasLoaded) {
      return this.state;
    }

    if (palitras.length === 0) {
      if (this.state.visiblePalitraIds.length > 0) {
        return this.commit({ ...this.state, visiblePalitraIds: [] });
      }
      return this.state;
    }

    const existingIds = new Set(palitras.map(palitraDetails => palitraDetails.palitra.id));
    const filtered = this.state.visiblePalitraIds.filter(id => existingIds.has(id));
    if (arraysEqual(filtered, this.state.visiblePalitraIds)) {
      return this.state;
    }
    return this.commit({ ...this.state, visiblePalitraIds: filtered });
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
      visiblePalitraIds: parseVisiblePalitraIds(parsed?.visiblePalitraIds)
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
  return featuresEqual(a.features, b.features) && arraysEqual(a.visiblePalitraIds, b.visiblePalitraIds);
}
