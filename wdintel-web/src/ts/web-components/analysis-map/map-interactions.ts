import * as L from 'leaflet';

export function patchMouseDownMapFocus(map: L.Map): void {
  const keyboardHandler = (
    map as L.Map & {
      keyboard?: { _onMouseDown?: (e: MouseEvent) => void; _focused?: boolean; _map?: L.Map };
    }
  ).keyboard;
  const originalOnMouseDown = keyboardHandler?._onMouseDown;
  if (!keyboardHandler || !originalOnMouseDown) {
    return;
  }

  const mapContainer = map.getContainer() as HTMLElement;
  L.DomEvent.off(mapContainer, 'mousedown', originalOnMouseDown, keyboardHandler);

  const patchedOnMouseDown = function (this: { _focused?: boolean; _map?: L.Map }) {
    if (this._focused) {
      return;
    }

    const container = this._map?.getContainer() as HTMLElement | undefined;
    if (!container) {
      return;
    }

    try {
      container.focus({ preventScroll: true });
    } catch (_error) {
      const body = document.body;
      const docEl = document.documentElement;
      const top = body.scrollTop || docEl.scrollTop;
      const left = body.scrollLeft || docEl.scrollLeft;
      container.focus();
      window.scrollTo(left, top);
    }
  };

  keyboardHandler._onMouseDown = patchedOnMouseDown;
  L.DomEvent.on(mapContainer, 'mousedown', patchedOnMouseDown, keyboardHandler);
}

export function suppressNativeContextMenu(
  map: L.Map,
  shouldHandleMapSurfaceContextMenu: (event: Event, map: L.Map) => boolean,
): void {
  const mapContainer = map.getContainer();
  mapContainer.addEventListener(
    'contextmenu',
    (event: MouseEvent) => {
      if (!shouldHandleMapSurfaceContextMenu(event, map)) {
        return;
      }
      event.preventDefault();
    },
    true,
  );
}

export function shouldHandleMapSurfaceContextMenu(event: Event, map: L.Map): boolean {
  const mapContainer = map.getContainer();
  const target = event.target;
  if (!(target instanceof Element) || !mapContainer.contains(target)) {
    return false;
  }

  if (
    target.closest('.analysis-map-coord-menu-overlay, .leaflet-control-container, .leaflet-control')
  ) {
    return false;
  }

  if (
    target.closest(
      '.leaflet-marker-pane, .leaflet-overlay-pane, .leaflet-popup-pane, .leaflet-shadow-pane, .leaflet-tooltip-pane',
    )
  ) {
    return false;
  }

  return (
    target === mapContainer || target.closest('.leaflet-tile-pane, .leaflet-map-pane') !== null
  );
}
