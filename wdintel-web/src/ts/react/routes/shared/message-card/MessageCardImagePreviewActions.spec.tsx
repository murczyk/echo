/**
 * @vitest-environment happy-dom
 */
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Button: ({
    children,
    component,
    startIcon,
    ...props
  }: { children?: ReactNode; component?: string; startIcon?: ReactNode } & Record<
    string,
    unknown
  >) => {
    const Component = component ?? 'button';
    return (
      <Component {...props}>
        {startIcon}
        {children}
      </Component>
    );
  },
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CircularProgress: ({ size }: { size?: number }) => (
    <span data-testid="circular-progress" data-size={size} />
  ),
  IconButton: ({
    children,
    disabled,
    component,
    ...props
  }: {
    children?: ReactNode;
    disabled?: boolean;
    component?: string;
  } & Record<string, unknown>) =>
    (() => {
      const Component = component ?? 'button';
      return (
        <Component disabled={disabled} {...props}>
          {children}
        </Component>
      );
    })(),
  Slider: () => <div />,
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useTheme: () => ({ palette: { divider: '#000' } }),
}));

import { MessageCardImagePreviewActions } from './MessageCardImagePreviewActions';
import { MessageMediaDownloadLink } from './MessageCardMedia';

function SharedMediaDownloadHarness() {
  const [activeKeys, setActiveKeys] = useState(() => new Set<string>());
  const isDownloadStarting = (downloadKey: string) => activeKeys.has(downloadKey);
  const onDownloadStart = (downloadKey: string) => {
    if (activeKeys.has(downloadKey)) return false;
    setActiveKeys((keys) => new Set(keys).add(downloadKey));
    return true;
  };

  return (
    <>
      <MessageMediaDownloadLink
        attachment={{
          id: 'shared',
          href: 'javascript:void(0)',
          fileName: 'shared.txt',
          contentType: 'text/plain',
        }}
        isDownloadStarting={isDownloadStarting}
        onDownloadStart={onDownloadStart}
      />
      <MessageCardImagePreviewActions
        currentHref="javascript:void(0)"
        downloadFileName="preview.png"
        hasCarousel={false}
        copyStatus="idle"
        canCopyImage={false}
        resolvedIndex={0}
        imageCount={1}
        onCopyImage={vi.fn()}
        onGoToPrevious={vi.fn()}
        onGoToNext={vi.fn()}
        onInfoClick={vi.fn()}
        onClose={vi.fn()}
        downloadKey="media:shared"
        isDownloadStarting={isDownloadStarting}
        onDownloadStart={onDownloadStart}
      />
    </>
  );
}

describe('MessageCardImagePreviewActions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('disables image copy before the preview image is loaded', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardImagePreviewActions
          currentHref="https://example.test/image.png"
          downloadFileName="image.png"
          hasCarousel={false}
          copyStatus="idle"
          canCopyImage={false}
          resolvedIndex={0}
          imageCount={1}
          onCopyImage={vi.fn()}
          onGoToPrevious={vi.fn()}
          onGoToNext={vi.fn()}
          onInfoClick={vi.fn()}
          onClose={vi.fn()}
          downloadKey="media:image-1"
          isDownloadStarting={() => false}
          onDownloadStart={vi.fn(() => true)}
        />,
      );
    });

    const copyButton = document.body.querySelector('button[aria-label="Скопіювати зображення"]');
    expect(copyButton).not.toBeNull();
    expect((copyButton as HTMLButtonElement).disabled).toBe(true);
    root.unmount();
  });

  it('blocks the same media key between its card and preview controls', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const fetchMock = vi.spyOn(window, 'fetch').mockResolvedValue(new Response());

    await act(async () => {
      root.render(<SharedMediaDownloadHarness />);
    });

    const cardDownload = container.querySelector('a[download="shared.txt"]');
    const previewDownload = container.querySelector('a[download="preview.png"]');
    expect(cardDownload).not.toBeNull();
    expect(previewDownload).not.toBeNull();

    await act(async () => {
      cardDownload?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(cardDownload?.getAttribute('aria-label')).toBe('Завантаження…');
    expect(previewDownload?.getAttribute('disabled')).not.toBeNull();
    const duplicateEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      previewDownload?.dispatchEvent(duplicateEvent);
    });
    expect(duplicateEvent.defaultPrevented).toBe(true);

    root.unmount();
    fetchMock.mockRestore();
  });
});
