/**
 * @vitest-environment happy-dom
 */
import { createElement, forwardRef, type ElementType, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageMediaInfo } from '../../../../../../../Bindings';

const authRedirectMocks = vi.hoisted(() => ({
  emitUnauthorizedEvent: vi.fn(),
}));

vi.mock('../../../../../auth-redirect', () => authRedirectMocks);

vi.mock('@mui/material', () => ({
  Box: ({
    component = 'div',
    children,
    sx: _sx,
    ...props
  }: {
    component?: ElementType;
    children?: ReactNode;
    sx?: unknown;
  }) => createElement(component, props, children),
  ButtonBase: forwardRef<
    HTMLButtonElement,
    {
      children?: ReactNode;
      onClick?: () => void;
      disabled?: boolean;
      'aria-label'?: string;
      'data-video-thumb-state'?: string;
    }
  >(function ButtonBase(
    { children, onClick, disabled, 'aria-label': ariaLabel, 'data-video-thumb-state': state },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        data-video-thumb-state={state}
      >
        {children}
      </button>
    );
  }),
  CircularProgress: (props: Record<string, unknown>) => <span {...props}>loading</span>,
  IconButton: ({
    children,
    component,
    href,
    target,
    rel,
    ...props
  }: {
    children?: ReactNode;
    component?: ElementType;
    href?: string;
    target?: string;
    rel?: string;
  } & Record<string, unknown>) => {
    const Component = component ?? 'button';
    return createElement(Component, { href, target, rel, ...props }, children);
  },
  Skeleton: () => <span data-skeleton />,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@mui/icons-material/PlayArrow', () => ({
  default: () => <span data-play-icon />,
}));

import { MessageCardVideoThumb } from '../../MessageCardVideoThumb';

function buildAttachment(overrides: Partial<MessageMediaInfo> = {}): MessageMediaInfo {
  return {
    id: 'video-1',
    href: '/api/messenger/media/video-1',
    contentType: 'video/mp4',
    fileName: 'recording.mp4',
    sizeBytes: 1024,
    ...overrides,
  } as MessageMediaInfo;
}

function thumbnailResponse(status: number, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    blob: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })),
  } as unknown as Response;
}

async function renderThumb(attachment: MessageMediaInfo) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <MessageCardVideoThumb
        attachment={attachment}
        index={0}
        onOpen={vi.fn()}
        isDownloadStarting={() => false}
        onDownloadStart={() => true}
      />,
    );
  });

  return { container, root };
}

describe('MessageCardVideoThumb', () => {
  beforeEach(() => {
    authRedirectMocks.emitUnauthorizedEvent.mockReset();
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:thumbnail'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('fetches only the dedicated thumbnail image', async () => {
    vi.mocked(fetch).mockResolvedValue(thumbnailResponse(200));
    const { container, root } = await renderThumb(buildAttachment());

    expect(fetch).toHaveBeenCalledWith(
      '/api/messenger/media/video-1/thumbnail',
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:thumbnail');
    expect(container.querySelector('video')).toBeNull();

    await act(async () => {
      container.querySelector('img')?.dispatchEvent(new Event('load', { bubbles: true }));
    });
    expect(container.querySelector('[data-video-thumb-state="loaded"]')).not.toBeNull();
    root.unmount();
  });

  it('waits until the thumbnail is near the viewport before fetching', async () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }

        observe() {}

        disconnect() {
          disconnect();
        }
      },
    );
    vi.mocked(fetch).mockResolvedValue(thumbnailResponse(200));
    const { container, root } = await renderThumb(buildAttachment());

    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:thumbnail');
    expect(disconnect).not.toHaveBeenCalled();
    root.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('pauses pending thumbnail polling offscreen and resumes it on re-entry', async () => {
    vi.useFakeTimers();
    let intersectionCallback: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }

        observe() {}

        disconnect() {}
      },
    );
    vi.mocked(fetch).mockResolvedValue(thumbnailResponse(202, { 'Retry-After': '2' }));
    const { root } = await renderThumb(buildAttachment());

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    root.unmount();
  });

  it('retries a pending thumbnail using Retry-After and then displays it', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch)
      .mockResolvedValueOnce(thumbnailResponse(202, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(thumbnailResponse(200));
    const { container, root } = await renderThumb(buildAttachment());

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/messenger/media/video-1/thumbnail?retry=1',
      expect.any(Object),
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:thumbnail');
    expect(container.querySelector('video')).toBeNull();
    root.unmount();
  });

  it('keeps polling at the capped delay while the thumbnail is pending', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(thumbnailResponse(202, { 'Retry-After': '2' }));
    const { container, root } = await renderThumb(
      buildAttachment({ id: '', href: '/api/messenger/media/video-from-href' }),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/messenger/media/video-from-href/thumbnail',
      expect.any(Object),
    );

    for (const delay of [2_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
    }

    expect(fetch).toHaveBeenLastCalledWith(
      '/api/messenger/media/video-from-href/thumbnail?retry=7',
      expect.any(Object),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(fetch).toHaveBeenCalledTimes(8);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/messenger/media/video-from-href/thumbnail?retry=8',
      expect.any(Object),
    );
    expect(container.querySelector('[data-video-thumb-state="loading"]')).not.toBeNull();
    expect(container.querySelector('[data-play-icon]')).not.toBeNull();
    expect(container.textContent).toContain('recording.mp4');
    root.unmount();
  });

  it('stops polling after the server reports terminal thumbnail failure', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(
      thumbnailResponse(422, {
        'x-messenger-media-thumbnail-status': 'failed',
      }),
    );
    const { container, root } = await renderThumb(buildAttachment());

    expect(container.querySelector('[data-video-thumb-state="failed"]')).not.toBeNull();
    expect(container.querySelector('[data-skeleton]')).toBeNull();
    expect(container.querySelector('[data-play-icon]')).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('routes thumbnail 401 responses through the unauthorized handler without retrying', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue(thumbnailResponse(401));
    const { container, root } = await renderThumb(buildAttachment());

    expect(authRedirectMocks.emitUnauthorizedEvent).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-video-thumb-state="failed"]')).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    root.unmount();
  });
});
