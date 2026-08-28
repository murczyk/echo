export enum BaseLayerId {
  Delta = 'esriWorldImagery',
  Google = 'googleHybrid',
  OpenStreetMap = 'openStreetMap',
}

export const DEFAULT_BASE_LAYER_ID = BaseLayerId.Delta;

export const BASE_LAYER_IDS = [
  BaseLayerId.Delta,
  BaseLayerId.Google,
  BaseLayerId.OpenStreetMap,
] as const;

export const BASE_LAYER_LABELS = {
  [BaseLayerId.Delta]: 'Delta',
  [BaseLayerId.Google]: 'Google',
  [BaseLayerId.OpenStreetMap]: 'OpenStreetMap',
} satisfies Record<BaseLayerId, string>;

export function isBaseLayerId(value: unknown): value is BaseLayerId {
  return BASE_LAYER_IDS.some((layerId) => layerId === value);
}
