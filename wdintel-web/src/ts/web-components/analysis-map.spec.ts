/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

import { parseCoordinateInput } from '../maps/coordinate-search';
import './analysis-map';

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
      } | null;
      _flyToCoordinate: (coords: { lat: number; lng: number }) => void;
      _map: {
        flyTo: (latlng: [number, number], zoom: number, options: { duration: number }) => void;
        addLayer: () => void;
        removeLayer: () => void;
      } | null;
      _isDateRangeLoading: boolean;
      _palitrasLoadState: string;
    };

    element._searchControl = {
      updateSearchLoading: vi.fn(),
      updateResultsCount: vi.fn(),
    };
    element._palitraManager = {
      setSearchQuery: vi.fn(),
    };
    element._flyToCoordinate = vi.fn();
    element._map = {
      flyTo: vi.fn(),
      addLayer: vi.fn(),
      removeLayer: vi.fn(),
    };
    element._isDateRangeLoading = false;
    element._palitrasLoadState = 'success';

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
});
