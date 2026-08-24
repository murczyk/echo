/**
 * @vitest-environment happy-dom
 */
import { createElement, forwardRef, type ElementType, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getMediaSummary, retryMediaSummary, mapCoordinates, useMediaQueryMock } = vi.hoisted(
  () => ({
    getMediaSummary: vi.fn(),
    retryMediaSummary: vi.fn(),
    mapCoordinates: vi.fn(),
    useMediaQueryMock: vi.fn().mockReturnValue(false),
  }),
);

vi.mock('@mui/material', () => ({
  alpha: () => 'transparent',
  Box: forwardRef<
    HTMLElement,
    { component?: ElementType; children?: ReactNode; sx?: unknown } & Record<string, unknown>
  >(function MockBox({ component = 'div', children, sx: _sx, ...props }, ref) {
    return createElement(component, { ...props, ref }, children);
  }),
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  CircularProgress: () => <span data-progress />,
  IconButton: ({
    children,
    disabled,
    onClick,
    ...props
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  } & Record<string, unknown>) => (
    <button disabled={disabled} onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Skeleton: () => <span data-skeleton />,
  Tooltip: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
    <span>
      {children}
      <span data-tooltip-content="true">{title}</span>
    </span>
  ),
  Typography: forwardRef<
    HTMLParagraphElement,
    { children?: ReactNode; variant?: string; className?: string } & Record<string, unknown>
  >(function MockTypography({ children, ...props }, ref) {
    return (
      <p ref={ref} {...props}>
        {children}
      </p>
    );
  }),
  useMediaQuery: (query: string) => useMediaQueryMock(query),
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ breakpoints: { down: () => '' } }),
}));

vi.mock('@mui/icons-material/ArrowLeft', () => ({
  default: () => <span data-icon="arrow-left" />,
}));
vi.mock('@mui/icons-material/ArrowRight', () => ({
  default: () => <span data-icon="arrow-right" />,
}));
vi.mock('@mui/icons-material/Description', () => ({
  default: () => <span data-icon="description" />,
}));
vi.mock('@mui/icons-material/InfoOutlined', () => ({ default: () => <span data-icon="info" /> }));
vi.mock('@mui/icons-material/KeyboardArrowDown', () => ({
  default: () => <span data-icon="arrow-down" />,
}));
vi.mock('@mui/icons-material/KeyboardArrowUp', () => ({
  default: () => <span data-icon="arrow-up" />,
}));
vi.mock('@mui/icons-material/Refresh', () => ({ default: () => <span data-icon="refresh" /> }));

vi.mock('../../../../../services/api/media-summary', () => ({
  getMediaSummary: (id: string, opts?: unknown, access?: string) =>
    getMediaSummary(id, opts, access),
  retryMediaSummary: (id: string, opts?: unknown, access?: string) =>
    retryMediaSummary(id, opts, access),
}));

vi.mock('../../../../../services/api/location', () => ({
  mapCoordinates: (points: unknown, opts?: unknown) => mapCoordinates(points, opts),
}));

import {
  clearMediaSummaryCache,
  MessageCardMediaSummary,
  MessageCardMediaSummaryCarousel,
} from '../../attachment-preview/MediaSummaryPreview';

describe('MessageCardMediaSummary', () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root != null && container != null) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
    vi.clearAllMocks();
    clearMediaSummaryCache();
  });

  const renderComponent = async (props: {
    mediaId?: string | null;
    status?: { state: string; lastError?: string | null; hasCoordinates?: boolean } | null;
    pagination?: {
      index: number;
      total: number;
      onPrev: () => void;
      onNext: () => void;
    } | null;
  }) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<MessageCardMediaSummary {...props} />);
    });
  };

  it('enables expand button and allows toggling when content exceeds 3 lines via scrollHeight', async () => {
    const summaryText =
      "У документі наведено опис аерознімка сухого трав'янистого ландшафту з розрідженою рослинністю, зокрема невеликими деревами та чагарниками. Зазначено наявність ґрунтової стежки або дороги праворуч, а також ознаки ерозії або порушення рельєфу.";

    getMediaSummary.mockResolvedValueOnce({
      state: 'completed',
      summary: summaryText,
      coordinates: [],
      lastError: null,
    });

    const clientHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(60);
    const scrollHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(100);

    try {
      await renderComponent({
        mediaId: 'media-1',
        status: { state: 'completed', lastError: null, hasCoordinates: false },
      });

      const expandButton = container?.querySelector<HTMLButtonElement>(
        'button[aria-label="Розгорнути опис"]',
      );
      expect(expandButton).not.toBeNull();
      expect(expandButton?.disabled).toBe(false);

      // Expand
      await act(async () => {
        expandButton?.click();
      });

      const collapseButton = container?.querySelector<HTMLButtonElement>(
        'button[aria-label="Згорнути опис"]',
      );
      expect(collapseButton).not.toBeNull();
      expect(collapseButton?.disabled).toBe(false);

      // Collapse
      await act(async () => {
        collapseButton?.click();
      });

      expect(container?.querySelector('button[aria-label="Розгорнути опис"]')).not.toBeNull();
    } finally {
      clientHeightSpy.mockRestore();
      scrollHeightSpy.mockRestore();
    }
  });

  it('keeps expand button disabled when text fits within 3 lines', async () => {
    const shortText = 'Короткий опис в один рядок';

    getMediaSummary.mockResolvedValueOnce({
      state: 'completed',
      summary: shortText,
      coordinates: [],
      lastError: null,
    });

    await renderComponent({
      mediaId: 'media-2',
      status: { state: 'completed', lastError: null, hasCoordinates: false },
    });

    const textElement = container?.querySelector('p');
    expect(textElement).not.toBeNull();

    // Mock no overflow: scrollHeight == clientHeight
    Object.defineProperty(textElement, 'clientHeight', { configurable: true, value: 20 });
    Object.defineProperty(textElement, 'scrollHeight', { configurable: true, value: 20 });

    await act(async () => {
      root?.render(
        <MessageCardMediaSummary
          mediaId="media-2"
          status={{ state: 'completed', lastError: null, hasCoordinates: false }}
        />,
      );
    });

    const expandButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Розгорнути опис"]',
    );
    expect(expandButton).not.toBeNull();
    expect(expandButton?.disabled).toBe(true);
  });

  it('enables expand button for summaries with more than 3 line breaks', async () => {
    const multiLineText = 'Рядок 1\nРядок 2\nРядок 3\nРядок 4';

    getMediaSummary.mockResolvedValueOnce({
      state: 'completed',
      summary: multiLineText,
      coordinates: [],
      lastError: null,
    });

    await renderComponent({
      mediaId: 'media-3',
      status: { state: 'completed', lastError: null, hasCoordinates: false },
    });

    const expandButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Розгорнути опис"]',
    );
    expect(expandButton).not.toBeNull();
    expect(expandButton?.disabled).toBe(false);
  });

  it('resets expanded state when mediaId changes', async () => {
    const multiLineText = 'Рядок 1\nРядок 2\nРядок 3\nРядок 4';

    getMediaSummary.mockResolvedValue({
      state: 'completed',
      summary: multiLineText,
      coordinates: [],
      lastError: null,
    });

    await renderComponent({
      mediaId: 'media-4',
      status: { state: 'completed', lastError: null, hasCoordinates: false },
    });

    const expandButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Розгорнути опис"]',
    );
    expect(expandButton?.disabled).toBe(false);

    // Expand
    await act(async () => {
      expandButton?.click();
    });

    expect(container?.querySelector('button[aria-label="Згорнути опис"]')).not.toBeNull();

    // Change mediaId
    await act(async () => {
      root?.render(
        <MessageCardMediaSummary
          mediaId="media-5"
          status={{ state: 'completed', lastError: null, hasCoordinates: false }}
        />,
      );
    });

    // Should be reset to collapsed
    expect(container?.querySelector('button[aria-label="Розгорнути опис"]')).not.toBeNull();
  });

  it('renders skeleton placeholders while summary is loading rather than empty text', async () => {
    let resolvePromise: (value: unknown) => void = () => {};
    const pendingPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    getMediaSummary.mockReturnValueOnce(pendingPromise);

    await renderComponent({
      mediaId: 'media-pending',
      status: { state: 'completed', lastError: null, hasCoordinates: false },
    });

    const skeletons = container?.querySelectorAll('[data-skeleton]');
    expect(skeletons?.length).toBe(3);

    // Resolve summary
    await act(async () => {
      resolvePromise({
        state: 'completed',
        summary: 'Опис завантажено',
        coordinates: [],
        lastError: null,
      });
    });

    expect(container?.querySelector('[data-skeleton]')).toBeNull();
    expect(container?.textContent).toContain('Опис завантажено');
  });

  it('prefetches summaries for all carousel media items', async () => {
    getMediaSummary.mockResolvedValue({
      state: 'completed',
      summary: 'Опис медіа',
      coordinates: [],
      lastError: null,
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <MessageCardMediaSummaryCarousel
          media={[
            {
              id: 'media-10',
              summary: { state: 'completed', lastError: null, hasCoordinates: false },
            },
            {
              id: 'media-11',
              summary: { state: 'completed', lastError: null, hasCoordinates: false },
            },
          ]}
        />,
      );
    });

    expect(getMediaSummary).toHaveBeenCalledWith('media-10', undefined, 'messenger');
    expect(getMediaSummary).toHaveBeenCalledWith('media-11', undefined, 'messenger');
  });
});
