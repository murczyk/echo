/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseCoordinateInput } from '../maps/coordinate-search';
import { L } from '../maps/leaflet-markercluster';
import './analysis-map';

afterEach(() => vi.restoreAllMocks());

describe('analysis-map', () => {
  function createAnalysisMap() {
    const element = document.createElement('analysis-map') as unknown as {
      _searchSubmitHandler: (event: CustomEvent<string>) => void;
      _handleSearchAttributeChanged: (newValue: string) => void;
      _searchControl: {
        updateSearchLoading: (isLoading: boolean) => void;
        updateResultsCount: (count: number | null) => void;
      } | null;
      _palitraManager: {
        setSearchQuery: (query: string) => void;
        fitPalitras: (palitraIds: number[]) => void;
      } | null;
      _flyToCoordinate: (coords: { lat: number; lng: number }) => void;
      _map: {
        flyTo: (latlng: [number, number], zoom: number, options: { duration: number }) => void;
        addLayer: () => void;
        removeLayer: () => void;
      } | null;
      _isDateRangeLoading: boolean;
      _palitrasLoadState: string;
      _handleFocusPalitrasRequest: (palitraIds: number[]) => void;
    };

    element._searchControl = {
      updateSearchLoading: vi.fn(),
      updateResultsCount: vi.fn(),
    };
    element._palitraManager = {
      setSearchQuery: vi.fn(),
      fitPalitras: vi.fn(),
    };
    element._flyToCoordinate = vi.fn();
    element._map = {
      flyTo: vi.fn(),
      addLayer: vi.fn(),
      removeLayer: vi.fn(),
    };
    element._isDateRangeLoading = false;
    element._palitrasLoadState = 'success';
    element._handleFocusPalitrasRequest = vi.fn(function (
      this: typeof element,
      palitraIds: number[],
    ) {
      this._palitraManager?.fitPalitras(palitraIds);
    });

    return element;
  }

  it('does not clear popup state when the messages payload becomes empty before loading finishes', () => {
    const element = Object.create(
      (customElements.get('analysis-map') as CustomElementConstructor).prototype,
    ) as HTMLElement;
    const clickedPoint = { closePopup: vi.fn() };
    const map = { closePopup: vi.fn() };
    const analysisMap = element as unknown as {
      _map: typeof map | null;
      _clickedPoint: typeof clickedPoint | null;
      _clickedLatLng: null;
      _messagesPopupPending: boolean;
      _messagesPopupOpenRetryCount: number;
      attributeChangedCallback: (name: string, oldValue: string | null, newValue: string) => void;
    };

    analysisMap._map = map;
    analysisMap._clickedPoint = clickedPoint;
    analysisMap._clickedLatLng = null;
    analysisMap._messagesPopupPending = true;
    analysisMap._messagesPopupOpenRetryCount = 2;

    analysisMap.attributeChangedCallback(
      'messages',
      JSON.stringify({ messages: [{ id: 1 }], networkUnits: [] }),
      JSON.stringify({ messages: [], networkUnits: [] }),
    );

    expect(clickedPoint.closePopup).not.toHaveBeenCalled();
    expect(map.closePopup).not.toHaveBeenCalled();
    expect(analysisMap._messagesPopupPending).toBe(true);
    expect(analysisMap._messagesPopupOpenRetryCount).toBe(2);
    expect(analysisMap._clickedPoint).toBe(clickedPoint);
    expect(analysisMap._clickedLatLng).toBeNull();
  });

  it('clears stale popup state when loading finishes without messages', () => {
    const element = Object.create(
      (customElements.get('analysis-map') as CustomElementConstructor).prototype,
    ) as HTMLElement;
    const clickedPoint = { closePopup: vi.fn() };
    const map = { closePopup: vi.fn() };
    const analysisMap = element as unknown as {
      _map: typeof map | null;
      _clickedPoint: typeof clickedPoint | null;
      _clickedLatLng: null;
      _messages: unknown[];
      _messagesLoading: boolean;
      _messagesPopupPending: boolean;
      _messagesPopupOpenRetryCount: number;
      attributeChangedCallback: (name: string, oldValue: string | null, newValue: string) => void;
    };

    analysisMap._map = map;
    analysisMap._clickedPoint = clickedPoint;
    analysisMap._clickedLatLng = null;
    analysisMap._messages = [];
    analysisMap._messagesLoading = true;
    analysisMap._messagesPopupPending = true;
    analysisMap._messagesPopupOpenRetryCount = 2;

    analysisMap.attributeChangedCallback('messages-loading', 'true', 'false');

    expect(clickedPoint.closePopup).toHaveBeenCalledTimes(1);
    expect(map.closePopup).not.toHaveBeenCalled();
    expect(analysisMap._messagesLoading).toBe(false);
    expect(analysisMap._messagesPopupPending).toBe(false);
    expect(analysisMap._messagesPopupOpenRetryCount).toBe(0);
    expect(analysisMap._clickedPoint).toBeNull();
    expect(analysisMap._clickedLatLng).toBeNull();
  });

  it('flies to coordinates on search-submit even when the value was submitted before', () => {
    const analysisMap = createAnalysisMap();

    analysisMap._searchSubmitHandler(
      new CustomEvent('search-submit', { detail: '47.42135, 35.62197' }),
    );
    analysisMap._searchSubmitHandler(
      new CustomEvent('search-submit', { detail: '47.42135, 35.62197' }),
    );

    expect(analysisMap._flyToCoordinate).toHaveBeenCalledTimes(2);
    expect(analysisMap._flyToCoordinate).toHaveBeenNthCalledWith(1, {
      lat: 47.42135,
      lng: 35.62197,
    });
    expect(analysisMap._flyToCoordinate).toHaveBeenNthCalledWith(2, {
      lat: 47.42135,
      lng: 35.62197,
    });
    expect(analysisMap._palitraManager?.setSearchQuery).toHaveBeenCalledWith('');
    expect(analysisMap._searchControl?.updateSearchLoading).toHaveBeenCalledWith(false);
    expect(analysisMap._searchControl?.updateResultsCount).toHaveBeenCalledWith(null);
  });

  it('flies to a direct coordinate search attribute change without waiting for palitras', () => {
    const analysisMap = createAnalysisMap();
    analysisMap._palitrasLoadState = 'loading';

    analysisMap.attributeChangedCallback('search', null, '47.42135, 35.62197');

    expect(analysisMap._flyToCoordinate).toHaveBeenCalledWith({
      lat: 47.42135,
      lng: 35.62197,
    });
    expect(analysisMap._palitraManager?.setSearchQuery).toHaveBeenCalledWith('');
    expect(analysisMap._searchControl?.updateSearchLoading).toHaveBeenCalledWith(false);
    expect(analysisMap._searchControl?.updateResultsCount).toHaveBeenCalledWith(null);
  });

  it('clears the palette query on coordinate submit', () => {
    const analysisMap = createAnalysisMap();
    const coords = parseCoordinateInput('11T XT 11111 11111');
    expect(coords).not.toBeNull();

    analysisMap._searchSubmitHandler(
      new CustomEvent('search-submit', { detail: '11T XT 11111 11111' }),
    );

    expect(analysisMap._flyToCoordinate).toHaveBeenCalledWith(coords);
    expect(analysisMap._palitraManager?.setSearchQuery).toHaveBeenCalledWith('');
  });

  it('delegates non-coordinate search-submit values to palette search', () => {
    const analysisMap = createAnalysisMap();

    analysisMap._searchSubmitHandler(new CustomEvent('search-submit', { detail: 'точка 12' }));

    expect(analysisMap._flyToCoordinate).not.toHaveBeenCalled();
    expect(analysisMap._palitraManager?.setSearchQuery).toHaveBeenCalledWith('точка 12');
  });

  it('routes explicit palette focus requests to the palitra manager', () => {
    const analysisMap = createAnalysisMap();

    analysisMap._handleFocusPalitrasRequest([1, 2, 2]);

    expect(analysisMap._palitraManager?.fitPalitras).toHaveBeenCalledWith([1, 2, 2]);
  });

  it('flies the map to the expected zoom level for direct coordinates', () => {
    const analysisMap = Object.create(
      (customElements.get('analysis-map') as CustomElementConstructor).prototype,
    ) as HTMLElement;
    const map = {
      flyTo: vi.fn(),
      addLayer: vi.fn(),
      removeLayer: vi.fn(),
    };
    (
      analysisMap as unknown as {
        _map: typeof map | null;
        _coordinateSearchMarker: null;
        _flyToCoordinate: (coords: { lat: number; lng: number }) => void;
      }
    )._map = map;

    (
      analysisMap as unknown as {
        _coordinateSearchMarker: null;
        _flyToCoordinate: (coords: { lat: number; lng: number }) => void;
      }
    )._flyToCoordinate({ lat: 47.42135, lng: 35.62197 });

    expect(map.flyTo).toHaveBeenCalledWith([47.42135, 35.62197], 13, { duration: 0.4 });
  });

  it('loads linked inbox items when a settlement marker is clicked', () => {
    let clickHandler: (() => void) | undefined;
    const marker = {
      addTo: vi.fn(),
      bindTooltip: vi.fn(),
      getElement: vi.fn().mockReturnValue(null),
      getLatLng: vi.fn().mockReturnValue({ lat: 49.99, lng: 36.23 }),
      on: vi.fn((_event: string, handler: () => void) => {
        clickHandler = handler;
      }),
    };
    vi.spyOn(L, 'circleMarker').mockReturnValue(marker as never);
    const layer = { addTo: vi.fn(), clearLayers: vi.fn() };
    const map = { removeLayer: vi.fn() };
    const analysisMap = document.createElement('analysis-map') as HTMLElement & {
      _canShowSettlements: boolean;
      _map: typeof map;
      _replaceSettlementsOnMap: () => void;
      _settlementMarkers: Map<number, unknown>;
      _settlements: unknown[];
      _settlementsLayerGroup: typeof layer;
      _showSettlements: boolean;
    };
    analysisMap._map = map;
    analysisMap._settlementsLayerGroup = layer;
    analysisMap._settlementMarkers = new Map();
    analysisMap._canShowSettlements = true;
    analysisMap._showSettlements = true;
    analysisMap._settlements = [
      {
        settlement_id: 7,
        name: '<Харків>',
        region: 'Харківська',
        lat: 49.99,
        lon: 36.23,
        inbox_item_count: 3,
        inbox_item_ids: [11, 12, 13],
      },
    ];
    const listener = vi.fn();
    analysisMap.addEventListener('load-messages-description', listener);

    analysisMap._replaceSettlementsOnMap();
    clickHandler?.();

    expect(marker.bindTooltip).toHaveBeenCalledWith('&lt;Харків&gt; (3)', { direction: 'top' });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].detail).toEqual({ messageIds: [11, 12, 13] });
  });

  it('does not redispatch settlement changes already emitted by the settings control', () => {
    const analysisMap = document.createElement('analysis-map') as HTMLElement & {
      _canShowSettlements: boolean;
      _setShowSettlements: (show: boolean) => void;
      _showSettlements: boolean;
    };
    const listener = vi.fn();
    analysisMap._canShowSettlements = true;
    analysisMap.addEventListener('show-settlements-change', listener);

    analysisMap._setShowSettlements(true);

    expect(analysisMap._showSettlements).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });
});
