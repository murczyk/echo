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
    fitBounds: vi.fn(() => map),
    getZoom: vi.fn(() => 13),
    getContainer() {
      return container;
    },
    invalidateSize: vi.fn(),
    remove: vi.fn(),
  };
  const marker = {
    addTo: vi.fn(() => marker),
    on: vi.fn(() => marker),
    setLatLng: vi.fn(() => marker),
    setStyle: vi.fn(() => marker),
    remove: vi.fn(),
  };
  const zoomControl = {
    addTo: vi.fn(() => zoomControl),
  };

  return {
    map: vi.fn(() => map),
    latLngBounds: vi.fn((latLngs) => latLngs),
    circleMarker: vi.fn(() => marker),
    control: {
      zoom: vi.fn(() => zoomControl),
    },
  };
});

const clipboardMock = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
}));

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
    { children, sx, style, ...props },
    ref,
  ) {
    const computedStyle: Record<string, string> = {};
    if (sx != null && typeof sx === 'object' && !Array.isArray(sx)) {
      if (typeof sx.width === 'number' || typeof sx.width === 'string') {
        computedStyle.width = typeof sx.width === 'number' ? `${sx.width}px` : String(sx.width);
      }
      if (typeof sx.height === 'number' || typeof sx.height === 'string') {
        computedStyle.height = typeof sx.height === 'number' ? `${sx.height}px` : String(sx.height);
      }
      if (typeof sx.minHeight === 'number' || typeof sx.minHeight === 'string') {
        computedStyle.minHeight =
          typeof sx.minHeight === 'number' ? `${sx.minHeight}px` : String(sx.minHeight);
      }
    }

    return (
      <div
        ref={ref}
        style={{ ...(style as Record<string, string> | undefined), ...computedStyle }}
        {...props}
      >
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
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Dialog: ({
    children,
    open,
    fullScreen,
    PaperProps,
    onClose,
  }: {
    children?: ReactNode;
    open: boolean;
    fullScreen: boolean;
    PaperProps?: Record<string, unknown>;
    onClose: (event: unknown, reason: 'backdropClick' | 'escapeKeyDown') => void;
  }) => {
    shellProps.push({
      open,
      isFullscreen: fullScreen,
      ariaLabel: String(PaperProps?.['aria-label'] ?? ''),
      onClose,
    });
    return open ? (
      <div
        role="dialog"
        data-aria-label={String(PaperProps?.['aria-label'] ?? '')}
        data-fullscreen={String(fullScreen)}
      >
        {children}
      </div>
    ) : null;
  },
  IconButton: ({
    children,
    onClick,
    'aria-label': ariaLabel,
    sx,
    style,
    ...props
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'aria-label'?: string;
    sx?: Record<string, unknown>;
    style?: Record<string, string>;
  } & Record<string, unknown>) => {
    const computedStyle: Record<string, string> = {};
    if (sx != null && typeof sx === 'object' && !Array.isArray(sx)) {
      if (typeof sx.bgcolor === 'string') {
        computedStyle.backgroundColor = sx.bgcolor;
      }
      if (typeof sx.width === 'number' || typeof sx.width === 'string') {
        computedStyle.width = typeof sx.width === 'number' ? `${sx.width}px` : String(sx.width);
      }
      if (typeof sx.height === 'number' || typeof sx.height === 'string') {
        computedStyle.height = typeof sx.height === 'number' ? `${sx.height}px` : String(sx.height);
      }
    }

    return (
      <button
        aria-label={ariaLabel}
        onClick={onClick}
        style={{ ...(style ?? {}), ...computedStyle }}
        {...props}
      >
        {children}
      </button>
    );
  },
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
  Typography: ({
    children,
    sx,
    style,
    ...props
  }: {
    children?: ReactNode;
    sx?: Record<string, unknown>;
    style?: Record<string, string>;
  } & Record<string, unknown>) => {
    const computedStyle: Record<string, string> = {};
    if (sx != null && typeof sx === 'object' && !Array.isArray(sx)) {
      if (typeof sx.fontSize === 'number' || typeof sx.fontSize === 'string') {
        computedStyle.fontSize =
          typeof sx.fontSize === 'number' ? `${sx.fontSize}px` : String(sx.fontSize);
      }
      if (typeof sx.lineHeight === 'number' || typeof sx.lineHeight === 'string') {
        computedStyle.lineHeight = String(sx.lineHeight);
      }
      if (typeof sx.fontWeight === 'number' || typeof sx.fontWeight === 'string') {
        computedStyle.fontWeight = String(sx.fontWeight);
      }
      if (typeof sx.fontVariantNumeric === 'string') {
        computedStyle.fontVariantNumeric = sx.fontVariantNumeric;
      }
      if (typeof sx.height === 'number' || typeof sx.height === 'string') {
        computedStyle.height = typeof sx.height === 'number' ? `${sx.height}px` : String(sx.height);
      }
    }

    return (
      <div style={{ ...(style ?? {}), ...computedStyle }} {...props}>
        {children}
      </div>
    );
  },
  useTheme: () => ({
    palette: { divider: '#000', text: { secondary: '#666' }, background: { paper: '#fff' } },
  }),
}));

vi.mock('../../../../../../web-components/analysis-map/tile-layers', () => ({
  getTileLayers: vi.fn(() => tileLayers),
}));

vi.mock('leaflet', () => leafletMock);

vi.mock('../../../../../../copy-to-clipboard', () => clipboardMock);

import { MessageCardAttachmentPreviewProvider } from '../../attachment-preview/MessageCardAttachmentPreviewProvider';
import type { CoordinatePreviewPoint } from '../../message-coordinate-preview';

function TestCoordinatePreviewDialog({
  open,
  points,
  onClose,
  onIndexChange,
}: {
  open: boolean;
  points: CoordinatePreviewPoint[];
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  if (!open) return null;

  return (
    <MessageCardAttachmentPreviewProvider
      attachments={[{ type: 'coordinate', points }]}
      initialIndex={0}
      onClose={onClose}
      onIndexChange={onIndexChange}
    />
  );
}

describe('CoordinateAttachmentPreviewRenderer', () => {
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

  it('renders through the shared preview dialog and initializes once the host is measurable', async () => {
    const onClose = vi.fn();
    const points = [
      { lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355', source: 'direct' as const },
      { lat: 50.5, lng: 30.6, label: '50.50000, 30.60000', source: 'direct' as const },
    ];

    await act(async () => {
      root.render(
        <TestCoordinatePreviewDialog
          open
          points={points}
          onClose={onClose}
          onIndexChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(shellProps.at(-1)).toMatchObject({
      open: true,
      ariaLabel: 'Перегляд вкладення',
      isFullscreen: false,
    });
    expect(document.body.textContent).toContain('Завантаження мапи…');
    expect(leafletMock.map).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]') as HTMLElement | null;
    const closeButton = dialog?.querySelector(
      'button[aria-label="Закрити"]',
    ) as HTMLButtonElement | null;
    expect(closeButton).not.toBeNull();
    expect(closeButton?.getAttribute('data-variant')).toBeNull();

    await act(async () => {
      hostRect = { width: 800, height: 600 };
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    expect(tileLayers.googleHybrid.addTo).toHaveBeenCalledTimes(1);
    expect(tileLayers.openStreetMap.addTo).not.toHaveBeenCalled();
    expect(document.body.querySelectorAll('[data-wgs84-text]').length).toBe(1);
    expect(document.body.querySelector('button[aria-label="Супутник"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="OpenStreetMap"]')).not.toBeNull();
    expect(document.body.querySelector('button[aria-label="Копіювати MGRS"]')).not.toBeNull();
    expect(document.body.querySelectorAll('[data-mgrs-text]').length).toBe(1);
    const panel = document.body.querySelector(
      '[data-coordinate-panel="true"]',
    ) as HTMLElement | null;
    expect(panel).not.toBeNull();
    expect(panel?.style.display).toBe('inline-flex');
    expect(panel?.style.flexDirection).toBe('column');
    expect(panel?.style.alignItems).toBe('flex-start');
    expect(panel?.style.gap).toBe('6px');
    expect(panel?.style.padding).toBe('12px');
    expect(document.body.textContent).toContain('WGS84');
    expect(document.body.textContent).toContain('MGRS');
    const wgsLabel = document.body.querySelector(
      '[data-coordinate-label="wgs84"]',
    ) as HTMLElement | null;
    const mgrsLabel = document.body.querySelector(
      '[data-coordinate-label="mgrs"]',
    ) as HTMLElement | null;
    const wgsValue = document.body.querySelector('[data-wgs84-text]') as HTMLElement | null;
    const mgrsValue = document.body.querySelector('[data-mgrs-text]') as HTMLElement | null;
    expect(wgsLabel).not.toBeNull();
    expect(mgrsLabel).not.toBeNull();
    expect(wgsValue?.style.fontSize).toBe('14px');
    expect(mgrsValue?.style.fontSize).toBe('14px');
    expect(wgsValue?.style.lineHeight).toBe('1');
    expect(mgrsValue?.style.lineHeight).toBe('1');
    expect(wgsLabel?.style.fontSize).toBe('12px');
    expect(mgrsLabel?.style.fontSize).toBe('12px');
    expect(wgsLabel?.style.lineHeight).toBe('1');
    expect(mgrsLabel?.style.lineHeight).toBe('1');
    expect(wgsValue?.style.fontVariantNumeric).toBe('tabular-nums');
    expect(mgrsValue?.style.fontVariantNumeric).toBe('tabular-nums');
    expect(document.body.querySelector('[data-coordinate-row="ск-42"]')).toBeNull();
    expect(document.body.querySelector('[data-coordinate-row="уск-2000"]')).toBeNull();
    expect(document.body.querySelector('[data-coordinate-row="utm"]')).toBeNull();

    const expandButton = document.body.querySelector(
      'button[aria-label="Показати інші формати"]',
    ) as HTMLButtonElement | null;
    expect(expandButton).not.toBeNull();

    await act(async () => {
      expandButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.querySelector('[data-coordinate-row="ск-42"]')).not.toBeNull();
    expect(document.body.querySelector('[data-coordinate-row="уск-2000"]')).not.toBeNull();
    expect(document.body.querySelector('[data-coordinate-row="utm"]')).not.toBeNull();

    const wgsRow = document.body.querySelector(
      '[data-coordinate-row="wgs84"]',
    ) as HTMLElement | null;
    const mgrsRow = document.body.querySelector(
      '[data-coordinate-row="mgrs"]',
    ) as HTMLElement | null;
    expect(wgsRow?.style.display).toBe('flex');
    expect(wgsRow?.style.alignItems).toBe('center');
    expect(wgsRow?.style.height).toBe('24px');
    expect(mgrsRow?.style.display).toBe('flex');
    expect(mgrsRow?.style.alignItems).toBe('center');
    expect(mgrsRow?.style.height).toBe('24px');
    expect(wgsLabel?.style.width).toBe('80px');
    expect(mgrsLabel?.style.width).toBe('80px');
    const mgrsContent = document.body.querySelector(
      '[data-coordinate-row="mgrs-content"]',
    ) as HTMLElement | null;
    expect(mgrsContent).not.toBeNull();
    expect(mgrsContent?.style.display).toBe('grid');
    expect(mgrsContent?.style.alignItems).toBe('center');
    expect(mgrsContent?.style.height).toBe('24px');
    expect(mgrsContent?.style.width).toBe('100%');
    expect(mgrsContent?.style.gridTemplateColumns).toBe('minmax(0, 1fr) 20px');
    expect(mgrsContent?.querySelector('[data-mgrs-text]')).not.toBeNull();
    const copyButton = mgrsContent?.querySelector(
      'button[aria-label="Копіювати MGRS"]',
    ) as HTMLButtonElement | null;
    expect(copyButton).not.toBeNull();
    expect(copyButton?.style.width).toBe('20px');
    expect(copyButton?.style.height).toBe('20px');
    expect(wgsValue?.style.flex).toBe('1 1 auto');
    expect(wgsValue?.style.minWidth).toBe('0');
    expect(mgrsValue?.style.width).toBe('auto');

    const leaflet = await import('leaflet');
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(leaflet.map().fitBounds).toHaveBeenCalledWith(
      [
        [50.45044, 30.52355],
        [50.5, 30.6],
      ],
      expect.objectContaining({ maxZoom: 13, padding: [40, 40] }),
    );
    expect(leaflet.circleMarker).toHaveBeenCalledWith(
      [50.45044, 30.52355],
      expect.objectContaining({ interactive: true, bubblingMouseEvents: false }),
    );
    expect(leaflet.circleMarker).toHaveBeenCalledTimes(2);
    expect(leaflet.map().invalidateSize).toHaveBeenCalledTimes(1);
    expect(leaflet.circleMarker().setLatLng).not.toHaveBeenCalled();

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
      document.body
        .querySelector('button[aria-label="Наступна координата"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(leaflet.map().setView).toHaveBeenCalledWith([50.5, 30.6], 13);
    expect(document.body.querySelector('[data-coordinate-point-counter]')?.textContent).toContain(
      '2 / 2',
    );
    expect(leaflet.circleMarker().setStyle).toHaveBeenCalled();

    await act(async () => {
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    expect(leaflet.map().invalidateSize.mock.calls.length).toBe(
      invalidateCallsBeforeLayerSwitch + 2,
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
    });
    expect(leaflet.map().invalidateSize).toHaveBeenCalledTimes(
      invalidateCallsBeforeLayerSwitch + 3,
    );
  });

  it('wraps internal point navigation without inflating the attachment carousel', async () => {
    const onClose = vi.fn();
    const onIndexChange = vi.fn();
    const points = [
      { lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355', source: 'direct' as const },
      { lat: 50.5, lng: 30.6, label: '50.50000, 30.60000', source: 'direct' as const },
    ];

    await act(async () => {
      root.render(
        <TestCoordinatePreviewDialog
          open
          points={points}
          onClose={onClose}
          onIndexChange={onIndexChange}
        />,
      );
      await Promise.resolve();
    });

    hostRect = { width: 800, height: 600 };
    await act(async () => {
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    const leaflet = await import('leaflet');
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    const mapInstance = leaflet.map.mock.results[0]?.value as {
      setView: ReturnType<typeof vi.fn>;
      invalidateSize: ReturnType<typeof vi.fn>;
    };
    const markerInstance = leaflet.circleMarker.mock.results[0]?.value as {
      on: ReturnType<typeof vi.fn>;
      setLatLng: ReturnType<typeof vi.fn>;
      setStyle: ReturnType<typeof vi.fn>;
    };

    await act(async () => {
      document.body
        .querySelector('button[aria-label="Попередня координата"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onIndexChange).not.toHaveBeenCalled();
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(mapInstance.setView).toHaveBeenLastCalledWith([50.5, 30.6], 13);
    expect(markerInstance.setStyle).toHaveBeenCalled();

    await act(async () => {
      document.body
        .querySelector('button[aria-label="Наступна координата"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onIndexChange).not.toHaveBeenCalled();
    expect(leaflet.map).toHaveBeenCalledTimes(1);
    expect(mapInstance.setView).toHaveBeenLastCalledWith([50.45044, 30.52355], 13);
    expect(markerInstance.setStyle).toHaveBeenCalled();

    const selectSecondMarker = markerInstance.on.mock.calls[1]?.[1] as (() => void) | undefined;
    expect(selectSecondMarker).toBeTypeOf('function');
    await act(async () => {
      selectSecondMarker?.();
      await Promise.resolve();
    });

    expect(mapInstance.setView).toHaveBeenLastCalledWith([50.5, 30.6], 13);
    expect(document.body.querySelector('[data-coordinate-point-counter]')?.textContent).toContain(
      '2 / 2',
    );
  });

  it('keeps all points in view when coordinate metadata updates', async () => {
    const points = [
      { lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355', source: 'direct' as const },
      { lat: 50.5, lng: 30.6, label: '50.50000, 30.60000', source: 'direct' as const },
    ];

    await act(async () => {
      root.render(
        <TestCoordinatePreviewDialog
          open
          points={points}
          onClose={vi.fn()}
          onIndexChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    hostRect = { width: 800, height: 600 };
    await act(async () => {
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    const mapInstance = leafletMock.map.mock.results[0]?.value;
    const setViewCalls = mapInstance.setView.mock.calls.length;
    const fitBoundsCalls = mapInstance.fitBounds.mock.calls.length;
    expect(fitBoundsCalls).toBeGreaterThan(0);

    await act(async () => {
      root.render(
        <TestCoordinatePreviewDialog
          open
          points={points.map((point) => ({ ...point, label: `mapped ${point.label}` }))}
          onClose={vi.fn()}
          onIndexChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(mapInstance.setView).toHaveBeenCalledTimes(setViewCalls);
    expect(mapInstance.fitBounds).toHaveBeenCalledTimes(fitBoundsCalls);
  });

  it('does not navigate the carousel when swiping across the map surface', async () => {
    const onIndexChange = vi.fn();

    await act(async () => {
      root.render(
        <TestCoordinatePreviewDialog
          open
          points={[
            { lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355', source: 'direct' },
            { lat: 50.5, lng: 30.6, label: '50.50000, 30.60000', source: 'direct' },
          ]}
          onClose={vi.fn()}
          onIndexChange={onIndexChange}
        />,
      );
      await Promise.resolve();
    });

    const mapSurface = document.body.querySelector('[data-coordinate-marker-count]');
    expect(mapSurface).not.toBeNull();

    mapSurface?.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientX: 200, clientY: 100 } as Touch],
      }),
    );
    mapSurface?.dispatchEvent(
      new TouchEvent('touchend', {
        bubbles: true,
        changedTouches: [{ clientX: 50, clientY: 100 } as Touch],
      }),
    );

    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('ignores arrow navigation from editable and slider targets', async () => {
    const onClose = vi.fn();
    const onIndexChange = vi.fn();

    await act(async () => {
      root.render(
        <TestCoordinatePreviewDialog
          open
          points={[
            { lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355', source: 'direct' },
            { lat: 50.5, lng: 30.6, label: '50.50000, 30.60000', source: 'direct' },
          ]}
          onClose={onClose}
          onIndexChange={onIndexChange}
        />,
      );
      await Promise.resolve();
    });

    hostRect = { width: 800, height: 600 };
    await act(async () => {
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    const targets = [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      (() => {
        const element = document.createElement('div');
        element.setAttribute('contenteditable', 'true');
        return element;
      })(),
      (() => {
        const element = document.createElement('div');
        element.setAttribute('role', 'slider');
        return element;
      })(),
    ];

    for (const target of targets) {
      document.body.appendChild(target);
      await act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await Promise.resolve();
      });
      expect(onIndexChange).not.toHaveBeenCalled();
      target.remove();
    }
  });

  it('does not intercept arrow navigation when only one point is available', async () => {
    const onClose = vi.fn();
    const onIndexChange = vi.fn();

    await act(async () => {
      root.render(
        <TestCoordinatePreviewDialog
          open
          points={[{ lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355', source: 'direct' }]}
          onClose={onClose}
          onIndexChange={onIndexChange}
        />,
      );
      await Promise.resolve();
    });

    hostRect = { width: 800, height: 600 };
    await act(async () => {
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await Promise.resolve();
    });

    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it('shows retry UI when the host stays unmeasurable and reinitializes after retry', async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <TestCoordinatePreviewDialog
          open
          points={[{ lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355', source: 'direct' }]}
          onClose={onClose}
          onIndexChange={vi.fn()}
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
        <TestCoordinatePreviewDialog
          open
          points={[{ lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355', source: 'direct' }]}
          onClose={onClose}
          onIndexChange={vi.fn()}
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
    expect(closeButton?.getAttribute('data-variant')).toBeNull();
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
        <TestCoordinatePreviewDialog
          open={false}
          points={[{ lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355', source: 'direct' }]}
          onClose={onClose}
          onIndexChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(leafletMock.map().remove).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <TestCoordinatePreviewDialog
          open
          points={[{ lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355', source: 'direct' }]}
          onClose={onClose}
          onIndexChange={vi.fn()}
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

  it('keeps the coordinate panel stacked above the Leaflet surface without blocking controls', async () => {
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        <TestCoordinatePreviewDialog
          open
          points={[
            {
              lat: 50.45044,
              lng: 30.52355,
              label: 'very long coordinate label',
              source: 'direct',
            },
          ]}
          onClose={onClose}
          onIndexChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      hostRect = { width: 800, height: 600 };
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    const panel = document.body.querySelector('div[style*="pointer-events: none"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('WGS84');
    expect(panel?.textContent).toContain('MGRS');
    expect(document.body.querySelector('[data-wgs84-text]')?.textContent).toBe(
      '50.45044, 30.52355',
    );
    expect(document.body.querySelector('[data-mgrs-text]')?.textContent).not.toBe(
      'MGRS недоступні',
    );
    expect(panel?.getAttribute('style')).toContain('left: 16px');
    expect(panel?.getAttribute('style')).toContain('top: 16px');
    expect(panel?.getAttribute('style')).toContain('z-index: 1200');
  });

  it('keeps the copy status idle without an empty pill and shows success feedback briefly', async () => {
    vi.useFakeTimers();
    clipboardMock.copyTextToClipboard.mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        <TestCoordinatePreviewDialog
          open
          points={[{ lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355', source: 'direct' }]}
          onClose={vi.fn()}
          onIndexChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    hostRect = { width: 800, height: 600 };
    await act(async () => {
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    const copyButton = document.body.querySelector(
      'button[aria-label="Копіювати MGRS"]',
    ) as HTMLButtonElement | null;
    expect(copyButton).not.toBeNull();
    expect(copyButton?.disabled).toBe(false);
    expect(copyButton?.style.backgroundColor).toBe('transparent');
    expect(copyButton?.getAttribute('data-copy-status')).toBe('idle');
    expect(copyButton?.getAttribute('title')).toBe('Копіювати MGRS');
    expect(document.body.textContent).not.toContain('Скопійовано');
    expect(document.body.textContent).not.toContain('Не вдалося скопіювати');

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(clipboardMock.copyTextToClipboard).toHaveBeenCalledTimes(1);
    expect(clipboardMock.copyTextToClipboard).toHaveBeenCalledWith(expect.any(String));
    expect(copyButton?.getAttribute('data-copy-status')).toBe('copied');
    expect(copyButton?.getAttribute('title')).toBe('Скопійовано');
    expect(copyButton?.querySelector('svg')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Скопійовано');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(copyButton?.getAttribute('data-copy-status')).toBe('idle');
    expect(copyButton?.getAttribute('title')).toBe('Копіювати MGRS');
    expect(document.body.textContent).not.toContain('Скопійовано');
    expect(document.body.textContent).not.toContain('Не вдалося скопіювати');
  });

  it('shows failure feedback briefly when MGRS copying fails', async () => {
    vi.useFakeTimers();
    clipboardMock.copyTextToClipboard.mockRejectedValue(new Error('clipboard denied'));

    await act(async () => {
      root.render(
        <TestCoordinatePreviewDialog
          open
          points={[{ lat: 50.45044, lng: 30.52355, label: '50.45044, 30.52355', source: 'direct' }]}
          onClose={vi.fn()}
          onIndexChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    hostRect = { width: 800, height: 600 };
    await act(async () => {
      resizeObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    const copyButton = document.body.querySelector(
      'button[aria-label="Копіювати MGRS"]',
    ) as HTMLButtonElement | null;
    expect(copyButton).not.toBeNull();
    expect(copyButton?.disabled).toBe(false);
    expect(copyButton?.getAttribute('data-copy-status')).toBe('idle');

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(clipboardMock.copyTextToClipboard).toHaveBeenCalledTimes(1);
    expect(copyButton?.getAttribute('data-copy-status')).toBe('error');
    expect(copyButton?.getAttribute('title')).toBe('Не вдалося скопіювати');
    expect(document.body.textContent).not.toContain('Не вдалося скопіювати');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(copyButton?.getAttribute('data-copy-status')).toBe('idle');
    expect(copyButton?.getAttribute('title')).toBe('Копіювати MGRS');
    expect(document.body.textContent).not.toContain('Скопійовано');
    expect(document.body.textContent).not.toContain('Не вдалося скопіювати');
  });
});
