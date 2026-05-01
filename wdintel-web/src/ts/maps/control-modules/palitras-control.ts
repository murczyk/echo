import * as L from 'leaflet';
import { PalitraDetails } from '../palitra-types';

export type PalitrasLoadState = 'idle' | 'loading' | 'success' | 'error';

export interface PalitrasControl extends L.Control {
  updatePalitras: (palitras: PalitraDetails[], visibleIds: number[]) => void;
  setLoadState: (loadState: PalitrasLoadState) => void;
  setInteractionDisabled: (disabled: boolean) => void;
  setCollapsed: (collapsed: boolean) => void;
}

function normalizeVisibleIds(input: number[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  input.forEach((value) => {
    if (!Number.isFinite(value) || seen.has(value)) {
      return;
    }
    seen.add(value);
    result.push(value);
  });
  return result;
}

type PalitrasElementApi = HTMLElement & {
  setPalitras?: (palitras: PalitraDetails[]) => void;
  setVisibleIds?: (visibleIds: number[]) => void;
  setLoadState?: (loadState: PalitrasLoadState) => void;
  setInteractionDisabled?: (disabled: boolean) => void;
  setCollapsed?: (collapsed: boolean) => void;
};

export function createPalitrasControl(
  palitras: PalitraDetails[],
  visibleIds: number[],
  onVisibleIdsChange: (visibleIds: number[]) => void
): PalitrasControl {
  const PalitrasControlClass = L.Control.extend({
    _palitras: palitras,
    _visibleIds: visibleIds,
    _loadState: 'idle' as PalitrasLoadState,
    _interactionDisabled: false,
    _palitrasElement: null as PalitrasElementApi | null,

    onAdd: function (_map: L.Map) {
      this._container = L.DomUtil.create('div', 'leaflet-control palitras-control-host');
      const palitrasElement = document.createElement('analysis-map-palitras') as PalitrasElementApi;
      this._palitrasElement = palitrasElement;
      this._container.appendChild(palitrasElement);

      this._syncElementState();

      palitrasElement.addEventListener('palitras-visible-ids-change', (event: Event) => {
        const customEvent = event as CustomEvent<{ visibleIds?: number[] }>;
        const ids = customEvent.detail?.visibleIds;
        if (!Array.isArray(ids)) {
          return;
        }
        if (this._interactionDisabled) {
          return;
        }
        const normalizedIds = normalizeVisibleIds(ids);
        this._visibleIds = normalizedIds;
        onVisibleIdsChange(normalizedIds);
      });

      L.DomEvent.disableClickPropagation(this._container);
      L.DomEvent.disableScrollPropagation(this._container);

      return this._container;
    },

    onRemove: function (_map: L.Map) {
      this._palitrasElement = null;
    },

    _syncElementState: function () {
      if (!this._palitrasElement) {
        return;
      }
      this._palitrasElement.setPalitras?.(this._palitras);
      this._palitrasElement.setVisibleIds?.(this._visibleIds);
      this._palitrasElement.setLoadState?.(this._loadState);
      this._palitrasElement.setInteractionDisabled?.(this._interactionDisabled);
    },

    updatePalitras: function (palitras: PalitraDetails[], visibleIds: number[]) {
      this._palitras = palitras;
      this._visibleIds = normalizeVisibleIds(visibleIds);
      this._syncElementState();
    },

    setLoadState: function (loadState: PalitrasLoadState) {
      this._loadState = loadState;
      this._syncElementState();
    },

    setInteractionDisabled: function (disabled: boolean) {
      this._interactionDisabled = disabled;
      this._syncElementState();
    },

    setCollapsed: function (collapsed: boolean) {
      this._palitrasElement?.setCollapsed?.(collapsed);
    },
  });

  return new PalitrasControlClass({ position: 'topright' }) as PalitrasControl;
}
