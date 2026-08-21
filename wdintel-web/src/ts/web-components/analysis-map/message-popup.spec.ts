/**
 * @vitest-environment happy-dom
 */
import * as L from 'leaflet';
import { describe, expect, it, vi } from 'vitest';

import type { Message, NetworkUnit } from './types';
import { openMessagesPopup } from './message-popup';

describe('openMessagesPopup', () => {
  it('reports failure when there is no message content to render', () => {
    const opened = openMessagesPopup({
      map: null,
      clickedPoint: null,
      clickedLatLng: null,
      preferClickedLatLng: false,
      messages: [],
      networkUnits: [],
      selectedUnits: [],
      findPointMarkerByMessageId: vi.fn(),
      onUnitClicked: vi.fn(),
      setClickedState: vi.fn(),
    });

    expect(opened).toBe(false);
  });

  it('reports success when it can bind the popup to a restored point', () => {
    const bindPopup = vi.fn();
    const openPopup = vi.fn();
    const once = vi.fn();
    const restoredPoint = {
      getElement: () => document.createElementNS('http://www.w3.org/2000/svg', 'path'),
      getLatLng: () => L.latLng(49.1, 37.2),
      bindPopup,
      openPopup,
      once,
    };
    const messages: Message[] = [
      [
        17,
        {
          text: 'body',
          date: '2026-04-30',
          time: '01:42:11',
          coords: '49.1, 37.2',
        },
      ],
    ];

    const opened = openMessagesPopup({
      map: null,
      clickedPoint: null,
      clickedLatLng: L.latLng(49.1, 37.2),
      preferClickedLatLng: false,
      messages,
      networkUnits: [] as NetworkUnit[],
      selectedUnits: [],
      findPointMarkerByMessageId: vi.fn(() => restoredPoint as never),
      onUnitClicked: vi.fn(),
      setClickedState: vi.fn(),
    });

    expect(opened).toBe(true);
    expect(bindPopup).toHaveBeenCalled();
    expect(openPopup).toHaveBeenCalled();
    expect(once).toHaveBeenCalledWith('popupclose', expect.any(Function));
  });

  it('keeps the popup anchored to the clicked point instead of the newest message', () => {
    const bindPopup = vi.fn();
    const openPopup = vi.fn();
    const once = vi.fn();
    const clickedPoint = {
      getElement: () => document.createElementNS('http://www.w3.org/2000/svg', 'path'),
      getLatLng: () => L.latLng(49.2, 37.3),
      bindPopup,
      openPopup,
      once,
    };
    const findPointMarkerByMessageId = vi.fn();
    const messages: Message[] = [
      [
        99,
        {
          text: 'newer',
          date: '2026-04-30',
          time: '02:42:11',
          coords: '49.3, 37.4',
        },
      ],
      [
        17,
        {
          text: 'older',
          date: '2026-04-30',
          time: '01:42:11',
          coords: '49.1, 37.2',
        },
      ],
    ];

    const opened = openMessagesPopup({
      map: null,
      clickedPoint: clickedPoint as never,
      clickedLatLng: L.latLng(49.2, 37.3),
      preferClickedLatLng: false,
      messages,
      networkUnits: [] as NetworkUnit[],
      selectedUnits: [],
      findPointMarkerByMessageId,
      onUnitClicked: vi.fn(),
      setClickedState: vi.fn(),
    });

    expect(opened).toBe(true);
    expect(findPointMarkerByMessageId).not.toHaveBeenCalled();
    expect(bindPopup).toHaveBeenCalled();
    expect(openPopup).toHaveBeenCalled();
    expect(once).toHaveBeenCalledWith('popupclose', expect.any(Function));
  });

  it('keeps cluster clicks anchored to the cluster position even for one message', () => {
    const bindPopup = vi.fn();
    const openPopup = vi.fn();
    const once = vi.fn();
    const clickedPoint = {
      getElement: () => document.createElementNS('http://www.w3.org/2000/svg', 'path'),
      getLatLng: () => L.latLng(49.2, 37.3),
      bindPopup,
      openPopup,
      once,
    };
    const findPointMarkerByMessageId = vi.fn(() => clickedPoint as never);

    const opened = openMessagesPopup({
      map: {
        hasLayer: vi.fn(() => false),
        addLayer: vi.fn(),
        removeLayer: vi.fn(),
        closePopup: vi.fn(),
        once: vi.fn(),
      } as never,
      clickedPoint: null,
      clickedLatLng: L.latLng(49.2, 37.3),
      preferClickedLatLng: true,
      messages: [
        [
          17,
          {
            text: 'body',
            date: '2026-04-30',
            time: '01:42:11',
            coords: '49.1, 37.2',
          },
        ],
      ],
      networkUnits: [] as NetworkUnit[],
      selectedUnits: [],
      findPointMarkerByMessageId,
      onUnitClicked: vi.fn(),
      setClickedState: vi.fn(),
    });

    expect(opened).toBe(true);
    expect(findPointMarkerByMessageId).not.toHaveBeenCalled();
    expect(bindPopup).not.toHaveBeenCalled();
    expect(openPopup).not.toHaveBeenCalled();
  });

  it('loads another settlement page from the popup control', () => {
    const loadMoreButton = document.createElement('button');
    loadMoreButton.dataset.mapSettlementMessagesLoadMore = '';
    document.body.appendChild(loadMoreButton);
    const onLoadMoreMessages = vi.fn();
    const clickedPoint = {
      getElement: () => document.createElementNS('http://www.w3.org/2000/svg', 'path'),
      getLatLng: () => L.latLng(49.2, 37.3),
      bindPopup: vi.fn(),
      openPopup: vi.fn(),
      once: vi.fn(),
    };

    openMessagesPopup({
      map: null,
      clickedPoint: clickedPoint as never,
      clickedLatLng: L.latLng(49.2, 37.3),
      preferClickedLatLng: false,
      messages: [[17, { text: 'body', date: '2026-04-30', time: '01:42:11' }]],
      networkUnits: [],
      selectedUnits: [],
      findPointMarkerByMessageId: vi.fn(),
      hasMoreMessages: true,
      onLoadMoreMessages,
      contextTitle: 'Харків, Харківська',
      onUnitClicked: vi.fn(),
      setClickedState: vi.fn(),
    });

    loadMoreButton.click();

    expect(clickedPoint.bindPopup).toHaveBeenCalledWith(
      expect.stringMatching(/Харків, Харківська.*data-map-settlement-messages-load-more/s),
      expect.any(Object),
    );
    expect(onLoadMoreMessages).toHaveBeenCalledOnce();
    loadMoreButton.remove();
  });
});
