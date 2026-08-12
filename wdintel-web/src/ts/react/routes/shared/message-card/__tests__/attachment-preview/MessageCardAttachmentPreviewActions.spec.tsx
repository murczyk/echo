/**
 * @vitest-environment happy-dom
 */
import { useState, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  Box: ({ children, component, ...props }: { children?: ReactNode; component?: string }) => {
    const Component = component ?? 'div';
    return <Component {...props}>{children}</Component>;
  },
  Button: ({
    children,
    component,
    startIcon,
    ...props
  }: {
    children?: ReactNode;
    component?: string;
    startIcon?: ReactNode;
  } & Record<string, unknown>) => {
    const Component = component ?? 'button';
    return (
      <Component {...props}>
        {startIcon}
        {children}
      </Component>
    );
  },
  CircularProgress: ({ size }: { size?: number }) => (
    <span data-testid="circular-progress" data-size={size} />
  ),
  DialogActions: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  IconButton: ({
    children,
    disabled,
    component,
    ...props
  }: {
    children?: ReactNode;
    disabled?: boolean;
    component?: string;
  } & Record<string, unknown>) => {
    const Component = component ?? 'button';
    return (
      <Component disabled={disabled} {...props}>
        {children}
      </Component>
    );
  },
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children, title }: { children?: ReactNode; title?: ReactNode }) => (
    <span data-tooltip-title={typeof title === 'string' ? title : undefined}>{children}</span>
  ),
  Typography: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <span {...props}>{children}</span>
  ),
}));

vi.mock('@mui/material/styles', () => ({
  useTheme: () => ({ palette: { divider: '#000' } }),
}));

import { MessageCardAttachmentPreviewActions } from '../../attachment-preview/MessageCardAttachmentPreviewActions';
import { MessageCardDisabledControlCursorWrapper } from '../../MessageCardDisabledControlCursorWrapper';
import { MessageMediaDownloadLink } from '../../MessageCardMedia';

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
      <MessageCardAttachmentPreviewActions
        openHref="javascript:void(0)"
        download={{ href: 'javascript:void(0)', fileName: 'preview.png' }}
        navigation={{ index: 0, count: 1, onPrevious: vi.fn(), onNext: vi.fn() }}
        onInfoClick={vi.fn()}
        onClose={vi.fn()}
        downloadKey="media:shared"
        isDownloadStarting={isDownloadStarting}
        onDownloadStart={onDownloadStart}
      />
    </>
  );
}

describe('MessageCardAttachmentPreviewActions', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders one carousel for any attachment type', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <MessageCardAttachmentPreviewActions
          download={{ onDownload: vi.fn() }}
          navigation={{ index: 1, count: 3, onPrevious: vi.fn(), onNext: vi.fn() }}
          onInfoClick={vi.fn()}
          onClose={vi.fn()}
          downloadKey="media:attachment-1"
          isDownloadStarting={() => false}
          onDownloadStart={() => true}
        />,
      );
    });

    expect(container.querySelector('[data-attachment-preview-counter]')?.textContent).toBe('2 / 3');
    expect(container.querySelector('[data-attachment-preview-nav="prev"]')).not.toBeNull();
    expect(container.querySelector('[data-attachment-preview-nav="next"]')).not.toBeNull();
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

  it('forwards span props and refs from the disabled cursor wrapper', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const ref = { current: null as HTMLSpanElement | null };

    await act(async () => {
      root.render(
        <MessageCardDisabledControlCursorWrapper
          ref={ref}
          disabled
          data-testid="cursor-wrapper"
          aria-label="Disabled download"
        >
          <button disabled>Download</button>
        </MessageCardDisabledControlCursorWrapper>,
      );
    });

    const wrapper = container.querySelector('[data-testid="cursor-wrapper"]');
    expect(wrapper).toBe(ref.current);
    expect(wrapper?.tagName).toBe('SPAN');
    expect(wrapper?.getAttribute('aria-label')).toBe('Disabled download');
    expect(wrapper?.getAttribute('data-disabled')).toBe('true');
    root.unmount();
  });
});
