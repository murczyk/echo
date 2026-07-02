/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

import './analysis-map';

describe('analysis-map', () => {
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
});
