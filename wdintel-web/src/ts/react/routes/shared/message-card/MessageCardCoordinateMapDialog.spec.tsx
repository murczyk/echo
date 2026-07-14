/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act, Children, cloneElement, forwardRef, isValidElement } from 'react';
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

type ResizeObserverCallback = (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;

const resizeObserverInstances: ResizeObserverMock[] = [];
let hostRect = { width: 0, height: 0 };

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

class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObserverInstances.push(this);
  }

  trigger(): void {
    this.callback([] as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

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
  CircularProgress: () => <div data-progress />,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ToggleButtonGroup: ({
    children,
    value,
    onChange,
    exclusive,
    ...props
  }: {
    children?: ReactNode;
    value?: string;
    onChange?: (event: unknown, nextValue: string | null) => void;
    exclusive?: boolean;
  } & Record<string, unknown>) => (
    <div {...props}>
      {Children.map(children, (child) => {
        const renderToggleButton = (node: ReactNode): ReactNode => {
          if (!isValidElement(node)) {
            return node;
          }

          if (node.props.value == null) {
            return renderToggleButton(node.props.children);
          }

          const childValue = node.props.value as string | undefined;
          const selected = value === childValue;

          return cloneElement(node, {
            selected,
            onClick: (event: unknown) => {
              node.props.onClick?.(event);
              if (exclusive && onChange) {
                onChange(event, selected ? null : (childValue ?? null));
              }
            },
          });
        };

        return renderToggleButton(child);
      })}
    </div>
  ),
  ToggleButton: ({
    children,
    selected,
    onClick,
    value,
    'aria-label': ariaLabel,
    ...props
  }: {
    children?: ReactNode;
    selected?: boolean;
    onClick?: (event: unknown) => void;
    value?: string;
    'aria-label'?: string;
  } & Record<string, unknown>) => (
    <button
      aria-label={ariaLabel}
      aria-pressed={String(Boolean(selected))}
      data-selected={String(Boolean(selected))}
      data-value={value ?? ''}
      onClick={onClick}
      {...props}
    >
      {children}
    </button>
  ),
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
    resizeObserverInstances.splice(0);
    hostRect = { width: 0, height: 0 };
    vi.stubGlobal('ResizeObserver', ResizeObserverMock as unknown as typeof ResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      Promise.resolve().then(() => cb(0));
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(
        () =>
          ({
            x: 0,
            y: 0,
            width: hostRect.width,
            height: hostRect.height,
            top: 0,
            left: 0,
            right: hostRect.width,
            bottom: hostRect.height,
            toJSON: () => ({}),
          }) as DOMRect,
      );
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
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders through the shared preview shell and initializes once the host is measurable', async () => {
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

    expect(shellProps.at(-1)).toMatchObject({
      open: true,
      ariaLabel: 'Карта координат',
      isFullscreen: false,
      config: getMessageCardPreviewShellConfig('coordinate-map'),
    });
    expect(document.body.textContent).toContain('Завантаження мапи…');
    expect(leafletMock.map).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement | null;
    const actionBar = dialog?.lastElementChild as HTMLElement | null;
    expect(actionBar?.children.length).toBe(3);
    expect(actionBar?.children[2]?.querySelector('button[aria-label="Закрити"]')).not.toBeNull();

    await act(async () => {
      hostRect = { width: 800, height: 600 };
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    expect(tileLayers.googleHybrid.addTo).toHaveBeenCalledTimes(1);
    expect(tileLayers.openStreetMap.addTo).not.toHaveBeenCalled();
    expect(document.body.querySelector('button[aria-label="Супутник"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="OpenStreetMap"]')).not.toBeNull();

    const leaflet = await import('leaflet');
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(leaflet.map().setView).toHaveBeenCalledWith([50.45044, 30.52355], 13);
    expect(leaflet.circleMarker).toHaveBeenCalledWith([50.45044, 30.52355], expect.any(Object));
    expect(leaflet.map().invalidateSize).toHaveBeenCalledTimes(1);

    const setViewCallsBeforeLayerSwitch = leaflet.map().setView.mock.calls.length;
    const invalidateCallsBeforeLayerSwitch = leaflet.map().invalidateSize.mock.calls.length;

    const osmButton = document.body.querySelector(
      'button[aria-label="OpenStreetMap"]',
    ) as HTMLButtonElement | null;
    expect(osmButton).not.toBeNull();
    expect(osmButton?.getAttribute('data-selected')).toBe('false');

    await act(async () => {
      osmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(tileLayers.openStreetMap.addTo).toHaveBeenCalledTimes(1);
    expect(tileLayers.googleHybrid.remove).toHaveBeenCalledTimes(1);
    expect(
      document.body
        .querySelector('button[aria-label="OpenStreetMap"]')
        ?.getAttribute('data-selected'),
    ).toBe('true');
    expect(
      document.body.querySelector('button[aria-label="Супутник"]')?.getAttribute('data-selected'),
    ).toBe('false');
    expect(leaflet.map().setView.mock.calls.length).toBe(setViewCallsBeforeLayerSwitch);
    expect(leaflet.map().invalidateSize.mock.calls.length).toBe(invalidateCallsBeforeLayerSwitch);

    await act(async () => {
      osmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(tileLayers.openStreetMap.addTo).toHaveBeenCalledTimes(1);
    expect(tileLayers.googleHybrid.remove).toHaveBeenCalledTimes(1);
    expect(leaflet.map().setView.mock.calls.length).toBe(setViewCallsBeforeLayerSwitch);
    expect(
      document.body
        .querySelector('button[aria-label="OpenStreetMap"]')
        ?.getAttribute('data-selected'),
    ).toBe('true');

    await act(async () => {
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    expect(leaflet.map().invalidateSize.mock.calls.length).toBe(
      invalidateCallsBeforeLayerSwitch + 1,
    );

    const fullscreenButton = document.body.querySelector(
      'button[aria-label="Повноекранний режим"]',
    ) as HTMLButtonElement | null;
    expect(fullscreenButton).not.toBeNull();

    await act(async () => {
      fullscreenButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(shellProps.at(-1)).toMatchObject({
      open: true,
      isFullscreen: true,
      config: getMessageCardPreviewShellConfig('coordinate-map'),
    });
    expect(leaflet.map().invalidateSize).toHaveBeenCalledTimes(
      invalidateCallsBeforeLayerSwitch + 2,
    );
  });

  it('shows retry UI when the host stays unmeasurable and reinitializes after retry', async () => {
    vi.useFakeTimers();
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    expect(document.body.textContent).toContain('Не вдалося відкрити мапу');
    expect(document.body.querySelector('button[aria-label="Повторити"]')).not.toBeNull();
    expect(leafletMock.map).not.toHaveBeenCalled();

    hostRect = { width: 800, height: 600 };
    await act(async () => {
      document.body
        .querySelector('button[aria-label="Повторити"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    expect(leafletMock.map).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
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

    hostRect = { width: 800, height: 600 };
    await act(async () => {
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    const closeButton = document.body.querySelector(
      'button[aria-label="Закрити"]',
    ) as HTMLButtonElement | null;
    expect(closeButton).not.toBeNull();
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

    hostRect = { width: 800, height: 600 };
    await act(async () => {
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    expect(leafletMock.map.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the coordinate label stacked above the Leaflet surface without blocking controls', async () => {
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <MessageCardCoordinateMapDialog
          open
          coordinate={{ lat: 50.45044, lng: 30.52355, label: 'very long coordinate label' }}
          onClose={onClose}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      hostRect = { width: 800, height: 600 };
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    const label = document.body.querySelector('div[style*="pointer-events: none"]');
    expect(label).not.toBeNull();
    expect(label?.textContent).toContain('very long coordinate label');
    expect(label?.getAttribute('style')).toContain('right: 12px');
    expect(label?.getAttribute('style')).toContain('top: 12px');
    expect(label?.getAttribute('style')).toContain('z-index: 1200');
  });
});
