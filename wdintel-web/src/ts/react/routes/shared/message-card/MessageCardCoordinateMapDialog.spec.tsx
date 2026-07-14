/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act, forwardRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ShellRecord = {
  open: boolean;
  isFullscreen: boolean;
  ariaLabel: string;
  config: Record<string, unknown>;
  onClose: (event: unknown, reason: 'backdropClick' | 'escapeKeyDown') => void;
};

const shellProps: ShellRecord[] = [];
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

const leafletMock = vi.hoisted(() => {
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

vi.mock('@mui/material', () => ({
  Box: forwardRef<HTMLDivElement, { children?: ReactNode } & Record<string, unknown>>(function Box(
    { children, ...props },
    ref,
  ) {
    return (
      <div ref={ref} {...props}>
        {children}
      </div>
    );
  }),
  Button: ({
    children,
    onClick,
    variant,
    ...props
  }: {
    children?: ReactNode;
    onClick?: () => void;
    variant?: string;
  } & Record<string, unknown>) => (
    <button data-variant={variant ?? ''} onClick={onClick} {...props}>
      {children}
    </button>
  ),
  ButtonGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  IconButton: ({
    children,
    onClick,
    'aria-label': ariaLabel,
    ...props
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'aria-label'?: string;
  } & Record<string, unknown>) => (
    <button aria-label={ariaLabel} onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useTheme: () => ({
    palette: { divider: '#000', text: { secondary: '#666' }, background: { paper: '#fff' } },
  }),
}));

vi.mock('../../../../web-components/analysis-map/tile-layers', () => ({
  getTileLayers: vi.fn(() => tileLayers),
}));

vi.mock('leaflet', () => leafletMock);

vi.mock('./MessageCardPreviewShell', () => ({
  MessageCardPreviewShell: ({
    open,
    isFullscreen,
    ariaLabel,
    config,
    onClose,
    stage,
    controls,
    actions,
  }: {
    open: boolean;
    isFullscreen: boolean;
    ariaLabel: string;
    config: Record<string, unknown>;
    onClose: (event: unknown, reason: 'backdropClick' | 'escapeKeyDown') => void;
    stage?: ReactNode;
    controls?: ReactNode;
    actions?: ReactNode;
  }) => {
    shellProps.push({ open, isFullscreen, ariaLabel, config, onClose });
    return open ? (
      <div role="dialog" data-aria-label={ariaLabel} data-fullscreen={String(isFullscreen)}>
        {stage}
        {controls}
        {actions}
      </div>
    ) : null;
  },
}));

import { MessageCardCoordinateMapDialog } from './MessageCardCoordinateMapDialog';
import { getMessageCardPreviewShellConfig } from './message-card-preview-config';

describe('MessageCardCoordinateMapDialog', () => {
  let container: HTMLElement;
  let root: Root;
  let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn>;
  let blurSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    shellProps.splice(0);
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
    blurSpy = vi.spyOn(HTMLElement.prototype, 'blur');
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
      document.body.innerHTML = '';
    });
    getBoundingClientRectSpy.mockRestore();
    blurSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('renders through the shared preview shell and updates map size on fullscreen changes', async () => {
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

    expect(shellProps.at(-1)).toMatchObject({
      open: true,
      ariaLabel: 'Карта координат',
      isFullscreen: false,
      config: getMessageCardPreviewShellConfig('coordinate-map'),
    });
    expect(tileLayers.googleHybrid.addTo).toHaveBeenCalledTimes(1);
    expect(tileLayers.openStreetMap.addTo).not.toHaveBeenCalled();

    const leaflet = await import('leaflet');
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(leaflet.map().setView).toHaveBeenCalledWith([50.45044, 30.52355], 13);
    expect(leaflet.circleMarker).toHaveBeenCalledWith([50.45044, 30.52355], expect.any(Object));
    expect(leaflet.map().invalidateSize).toHaveBeenCalledTimes(1);

    const setViewCallsBeforeLayerSwitch = leaflet.map().setView.mock.calls.length;
    const invalidateCallsBeforeLayerSwitch = leaflet.map().invalidateSize.mock.calls.length;

    const osmButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'OpenStreetMap',
    ) as HTMLButtonElement | undefined;
    expect(osmButton).not.toBeUndefined();

    await act(async () => {
      osmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(tileLayers.openStreetMap.addTo).toHaveBeenCalledTimes(1);
    expect(tileLayers.googleHybrid.remove).toHaveBeenCalledTimes(1);
    expect(leaflet.map().setView.mock.calls.length).toBe(setViewCallsBeforeLayerSwitch);
    expect(leaflet.map().invalidateSize.mock.calls.length).toBe(invalidateCallsBeforeLayerSwitch);

    const fullscreenButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.getAttribute('aria-label')?.includes('Повноекранний режим'),
    ) as HTMLButtonElement | undefined;
    expect(fullscreenButton).not.toBeUndefined();

    leaflet.map().invalidateSize.mockClear();

    await act(async () => {
      fullscreenButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(shellProps.at(-1)).toMatchObject({
      open: true,
      isFullscreen: true,
      config: getMessageCardPreviewShellConfig('coordinate-map'),
    });
    expect(leaflet.map().invalidateSize).toHaveBeenCalledTimes(1);
  });

  it('blurs the active preview element and closes from shell close events', async () => {
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
    });

    const closeButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Закрити',
    ) as HTMLButtonElement | undefined;
    expect(closeButton).not.toBeUndefined();
    closeButton?.focus();

    await act(async () => {
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(blurSpy).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      shellProps.at(-1)?.onClose(new Event('keydown'), 'escapeKeyDown');
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledTimes(2);

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

    expect(leafletMock.map().remove).toHaveBeenCalledTimes(1);
  });
});
