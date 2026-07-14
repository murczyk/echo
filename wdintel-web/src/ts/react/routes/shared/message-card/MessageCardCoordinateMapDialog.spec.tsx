/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../../Bindings';
import { MessageCardCoordinateMapDialog } from './MessageCardCoordinateMapDialog';

vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material');
  return {
    ...actual,
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    DialogActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  };
});

const palitraApiMock = vi.hoisted(() => ({
  listMapPalitrasV2: vi.fn(),
  searchPalitraPoints: vi.fn(),
}));

vi.mock('../../../services/api/palitra', () => palitraApiMock);

const tileLayers = vi.hoisted(() => {
  const openStreetMap = {
    addTo: vi.fn(() => openStreetMap),
    remove: vi.fn(() => openStreetMap),
  };
  const googleHybrid = {
    addTo: vi.fn(() => googleHybrid),
    remove: vi.fn(() => googleHybrid),
  };
  return { openStreetMap, googleHybrid };
});

vi.mock('../../../../web-components/analysis-map/tile-layers', () => ({
  getTileLayers: vi.fn(() => tileLayers),
}));

vi.mock('leaflet', () => {
  const container = {
    style: {} as Record<string, string>,
  };
  const map = {
    setView: vi.fn(() => map),
    getContainer() {
      return container;
    },
    invalidateSize: vi.fn(),
    remove: vi.fn(),
  };
  const marker = {
    addTo: vi.fn(() => marker),
    remove: vi.fn(),
  };

  return {
    map: vi.fn(() => map),
    circleMarker: vi.fn(() => marker),
  };
});

function createMessage(): InboxMessage {
  return {
    messageUid: null,
    text: '',
    media: [],
    images: [],
    imageRecognized: [],
    date: null,
    time: null,
    freq: null,
    coords: null,
    callsigns: [],
    callsignsAlg2: [],
    checked: false,
    important: false,
    bookmarked: false,
    timestamp: null,
    groupMasterKey: null,
    sender: null,
    extendedForm: null,
    messageComments: [],
    post: null,
    inboxTags: [],
    pointTokens: [],
    textMarked: [],
  } as InboxMessage;
}

describe('MessageCardCoordinateMapDialog', () => {
  let container: HTMLElement;
  let root: Root;
  let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        top: 0,
        left: 0,
        right: 800,
        bottom: 600,
        toJSON: () => ({}),
      } as DOMRect);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
      document.body.innerHTML = '';
    });
    getBoundingClientRectSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('centers the map on the resolved coordinate without touching Palitra APIs', async () => {
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <MessageCardCoordinateMapDialog
          open
          coordinate={{ lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355' }}
          onClose={onClose}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(palitraApiMock.listMapPalitrasV2).not.toHaveBeenCalled();
    expect(palitraApiMock.searchPalitraPoints).not.toHaveBeenCalled();
    expect(tileLayers.googleHybrid.addTo).toHaveBeenCalledTimes(1);
    expect(tileLayers.openStreetMap.addTo).not.toHaveBeenCalled();
    expect(window.requestAnimationFrame).toHaveBeenCalled();

    const leaflet = await import('leaflet');
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(leaflet.map().setView).toHaveBeenCalledWith([50.45044, 30.52355], 13);
    expect(leaflet.circleMarker).toHaveBeenCalledWith([50.45044, 30.52355], expect.any(Object));

    await act(async () => {
      const osmButton = Array.from(document.body.querySelectorAll('button')).find(
        (button) => button.textContent === 'OSM',
      );
      osmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(tileLayers.openStreetMap.addTo).toHaveBeenCalledTimes(1);
    expect(tileLayers.googleHybrid.remove).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <MessageCardCoordinateMapDialog
          open={false}
          coordinate={{ lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355' }}
          onClose={onClose}
        />,
      );
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(leaflet.map().remove).toHaveBeenCalledTimes(1);
  });
});
