/** @vitest-environment happy-dom */
import { act, createElement, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mapCoordinates } from '../../../../../services/api/location.ts';
import { CoordinateInputPreview } from '../CoordinateInputPreview.tsx';

const mocks = vi.hoisted(() => {
  const mapInstance = {
    setView: vi.fn(),
    fitBounds: vi.fn(),
    remove: vi.fn(),
  };
  const marker = { addTo: vi.fn(), remove: vi.fn() };
  marker.addTo.mockReturnValue(marker);
  return {
    mapInstance,
    marker,
    tileLayerAddTo: vi.fn(),
  };
});

vi.mock('@mui/material', async () => {
  const { createElement, forwardRef } = await import('react');
  const Box = forwardRef<HTMLDivElement, { children?: ReactNode }>(({ children }, ref) =>
    createElement('div', { ref }, children),
  );
  const container = ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children);
  const button = ({ children, disabled, onClick, type, ...props }: ComponentProps<'button'>) =>
    createElement(
      'button',
      { disabled, onClick, type, 'aria-label': props['aria-label'] },
      children,
    );

  return {
    Badge: container,
    Box,
    Button: button,
    CircularProgress: () => createElement('span', { role: 'progressbar' }),
    Dialog: ({ children, open }: { children?: ReactNode; open: boolean }) =>
      open ? createElement('div', { role: 'dialog' }, children) : null,
    DialogActions: container,
    DialogContent: container,
    DialogTitle: container,
    IconButton: button,
    Stack: container,
    Tooltip: container,
    Typography: container,
  };
});

vi.mock('@mui/icons-material/MapOutlined', () => ({
  default: () => null,
}));

vi.mock('leaflet', () => ({
  map: vi.fn(() => mocks.mapInstance),
  circleMarker: vi.fn(() => mocks.marker),
  latLngBounds: vi.fn(() => ({ getCenter: () => ({ lat: 49.1, lng: 37.2 }) })),
}));

vi.mock('../../../../../../web-components/analysis-map/tile-layers.ts', () => ({
  DEFAULT_BASE_LAYER_ID: 'esriWorldImagery',
  getTileLayers: () => ({ esriWorldImagery: { addTo: mocks.tileLayerAddTo } }),
}));

vi.mock('../../../../../services/api/location.ts', () => ({ mapCoordinates: vi.fn() }));

vi.mock('../../../message-card/CoordinateAttachmentThumbnail.tsx', async () => {
  const { createElement } = await import('react');
  return {
    CoordinateAttachmentThumbnail: ({ onOpen }: { onOpen: () => void }) =>
      createElement('button', { 'aria-label': 'Превʼю координат', onClick: onOpen }, 'Map Preview'),
  };
});

vi.mock(
  '../../../message-card/attachment-preview/MessageCardAttachmentPreviewProvider.tsx',
  async () => {
    const { createElement } = await import('react');
    return {
      MessageCardAttachmentPreviewProvider: () => createElement('div', { role: 'dialog' }),
    };
  },
);

let container: HTMLDivElement;
let root: Root;
describe('CoordinateInputPreview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(mapCoordinates).mockResolvedValue([
      {
        coords: { lat: 49.12345, lon: 37.12345 },
        locality: null,
      },
    ]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('loads the map and locality only after the preview dialog opens', async () => {
    await act(async () =>
      root.render(
        createElement(CoordinateInputPreview, {
          value: '49.12345, 37.12345',
          busy: false,
          onError: vi.fn(),
        }),
      ),
    );

    expect(mapCoordinates).not.toHaveBeenCalled();
    const openButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Превʼю координат"]',
    );
    expect(openButton).not.toBeNull();

    await act(async () => openButton?.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(mapCoordinates).toHaveBeenCalledTimes(1);
  });
});
