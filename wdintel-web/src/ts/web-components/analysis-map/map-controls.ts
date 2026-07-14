import * as L from 'leaflet';

import {
  createAttributionControl,
  createLayerSwitchControl,
  createMapSettingsControl,
  createMapWindowControl,
  createPalitrasControl,
  createSearchControl,
  createTimeswitchControl,
  FeatureName,
  FeatureToggleState,
  LayerSwitchControl,
  MapSettingsControl,
  MapWindowControl,
  PalitrasControl,
  SearchControl,
  TimeswitchControl,
} from '../../maps/controls';

type TileLayers = {
  openStreetMap: L.TileLayer;
  googleHybrid: L.TileLayer;
};

type InitializeAnalysisMapControlsOptions = {
  map: L.Map;
  tileLayers: TileLayers;
  daterange: { startDate: number; endDate: number };
  isDateRangeInteractionLocked: boolean;
  isFullscreen: boolean;
  featureToggleState: FeatureToggleState;
  pelengLabelsPermanent: boolean;
  onToggleFullscreen: () => void;
  onFeatureToggle: (feature: FeatureName, enabled: boolean) => void;
  onPelengLabelsPermanentChange: (show: boolean) => void;
  onVisiblePalitraIdsChange: (visibleIds: number[]) => void;
  onFocusVisiblePalitras: () => void;
};

export function initializeAnalysisMapControls({
  map,
  tileLayers,
  daterange,
  isDateRangeInteractionLocked,
  isFullscreen,
  featureToggleState,
  pelengLabelsPermanent,
  onToggleFullscreen,
  onFeatureToggle,
  onPelengLabelsPermanentChange,
  onVisiblePalitraIdsChange,
  onFocusVisiblePalitras,
}: InitializeAnalysisMapControlsOptions): {
  switchTimeControl: TimeswitchControl;
  palitrasControl: PalitrasControl;
  searchControl: SearchControl;
  layerSwitchControl: LayerSwitchControl;
  mapSettingsControl: MapSettingsControl;
  mapWindowControl: MapWindowControl;
} {
  const switchTimeControl = createTimeswitchControl(daterange, isDateRangeInteractionLocked);
  const searchControl = createSearchControl();
  const mapWindowControl = createMapWindowControl(onToggleFullscreen, isFullscreen);
  const layerSwitchControl = createLayerSwitchControl(
    tileLayers,
    featureToggleState,
    onFeatureToggle,
  );
  const mapSettingsControl = createMapSettingsControl(
    pelengLabelsPermanent,
    onPelengLabelsPermanentChange,
  );
  const palitrasControl = createPalitrasControl(
    [],
    [],
    onVisiblePalitraIdsChange,
    onFocusVisiblePalitras,
  );

  map.addControl(searchControl);
  map.addControl(switchTimeControl);
  map.addControl(mapWindowControl);
  map.addControl(layerSwitchControl);
  map.addControl(mapSettingsControl);
  map.addControl(createAttributionControl());

  return {
    switchTimeControl,
    palitrasControl,
    searchControl,
    layerSwitchControl,
    mapSettingsControl,
    mapWindowControl,
  };
}
