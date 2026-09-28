/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOcrPage: vi.fn(),
  notify: vi.fn(),
  reprocessMediaOcr: vi.fn(),
}));

vi.mock('@mui/material', () => ({
  CircularProgress: () => <span data-progress />,
  IconButton: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  Menu: ({ children, open }: { children?: ReactNode; open: boolean }) =>
    open ? <div role="menu">{children}</div> : null,
  MenuItem: ({
    children,
    component,
    ...props
  }: {
    children?: ReactNode;
    component?: string;
  } & Record<string, unknown>) => {
    const Component = component ?? 'button';
    return <Component {...props}>{children}</Component>;
  },
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@mui/icons-material/MoreVert', () => ({ default: () => <span>⋮</span> }));
vi.mock('../../../../../services/api/ocr', () => ({
  getOcrPage: mocks.getOcrPage,
  reprocessMediaOcr: mocks.reprocessMediaOcr,
}));
vi.mock('../../../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify: mocks.notify }),
}));

import { MediaReprocessAction } from '../MediaReprocessAction';

const completedOcr = {
  state: 'completed',
  qualityStatus: 'accepted',
  processedPages: 1,
  totalPages: 1,
  lastError: null,
  queueSize: null,
  attempts: 0,
  statusLog: [],
};
describe('MediaReprocessAction', () => {
  let roots: Root[];

  function mountRoot(container: HTMLElement): Root {
    const root = createRoot(container);
    roots.push(root);
    return root;
  }

  beforeEach(() => {
    roots = [];
    mocks.getOcrPage.mockReset();
    mocks.getOcrPage.mockResolvedValue({ settings: { engines: [] } });
    mocks.notify.mockReset();
    mocks.reprocessMediaOcr.mockReset();
  });

  afterEach(() => {
    act(() => {
      roots.forEach((root) => root.unmount());
    });
    document.body.innerHTML = '';
  });

  it('shows OCR downloads in the overflow menu for non-admin users', async () => {
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.setAttribute('data-auth-user-roles', 'Rer');
    const container = document.createElement('div');
    shell.appendChild(container);
    document.body.appendChild(shell);
    const root = mountRoot(container);
    const onDownloadStart = vi.fn(() => true);

    await act(async () => {
      root.render(
        <MediaReprocessAction
          mediaId="media-id"
          supported
          ocr={completedOcr}
          onQueued={vi.fn()}
          downloadItems={[
            {
              label: 'Скачати DOCX',
              download: { href: '/ocr/docx', fileName: 'scan-ocr.docx' },
              downloadKey: 'media:media-id:ocr:docx',
            },
          ]}
          isDownloadStarting={() => false}
          onDownloadStart={onDownloadStart}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector('[aria-label="Більше дій"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const download = container.querySelector('a[download="scan-ocr.docx"]');
    expect(download?.textContent).toBe('Скачати DOCX');
    expect(download?.getAttribute('href')).toBe('/ocr/docx');
    expect(container.textContent).not.toContain('Обробити повторно');
    expect(mocks.getOcrPage).not.toHaveBeenCalled();

    await act(async () => {
      download?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onDownloadStart).toHaveBeenCalledWith('media:media-id:ocr:docx');
  });

  it('does not render an action control for non-admin users without downloads', async () => {
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.setAttribute('data-auth-user-roles', 'Rer');
    const container = document.createElement('div');
    shell.appendChild(container);
    document.body.appendChild(shell);
    const root = mountRoot(container);

    await act(async () => {
      root.render(
        <MediaReprocessAction mediaId="media-id" supported ocr={completedOcr} onQueued={vi.fn()} />,
      );
    });

    expect(container.querySelector('[aria-label="Більше дій"]')).toBeNull();
    expect(mocks.getOcrPage).not.toHaveBeenCalled();
    expect(mocks.reprocessMediaOcr).not.toHaveBeenCalled();
  });

  it('is visible only to admins and queues a fresh media run', async () => {
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.setAttribute('data-auth-user-roles', 'Rer');
    const container = document.createElement('div');
    shell.appendChild(container);
    document.body.appendChild(shell);
    const root = mountRoot(container);
    const onQueued = vi.fn();

    await act(async () => {
      root.render(
        <MediaReprocessAction
          mediaId="media/id"
          supported
          ocr={completedOcr}
          onQueued={onQueued}
        />,
      );
    });
    expect(container.querySelector('[aria-label="Більше дій"]')).toBeNull();

    shell.setAttribute('data-auth-user-roles', 'Rer, Admin');
    await act(async () => {
      root.render(
        <MediaReprocessAction
          mediaId="media/id"
          supported
          ocr={completedOcr}
          onQueued={onQueued}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector('[aria-label="Більше дій"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const queued = { ...completedOcr, state: 'queued' };
    mocks.reprocessMediaOcr.mockResolvedValueOnce(queued);
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Повторно запустити OCR')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.reprocessMediaOcr).toHaveBeenCalledWith('media/id');
    expect(onQueued).toHaveBeenCalledWith(queued);
    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Медіа додано до черги повторної обробки.',
    });
  });

  it('queues OCR through the selected admin engine', async () => {
    mocks.getOcrPage.mockResolvedValueOnce({
      settings: { engines: [{ id: 17, name: 'Engine 17' }] },
    });
    mocks.reprocessMediaOcr.mockResolvedValueOnce({ ...completedOcr, state: 'queued' });
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.setAttribute('data-auth-user-roles', 'Admin');
    const container = document.createElement('div');
    shell.appendChild(container);
    document.body.appendChild(shell);
    const root = mountRoot(container);

    await act(async () => {
      root.render(
        <MediaReprocessAction mediaId="media-id" supported ocr={completedOcr} onQueued={vi.fn()} />,
      );
    });
    await act(async () => {
      container
        .querySelector('[aria-label="Більше дій"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => Promise.resolve());
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Повторно запустити OCR через Engine 17')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.getOcrPage).toHaveBeenCalledWith(1);
    expect(mocks.reprocessMediaOcr).toHaveBeenCalledWith('media-id', 17);
  });

  it('disables reprocessing while OCR is already active', async () => {
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.setAttribute('data-auth-user-roles', 'Admin');
    const container = document.createElement('div');
    shell.appendChild(container);
    document.body.appendChild(shell);
    const root = mountRoot(container);

    await act(async () => {
      root.render(
        <MediaReprocessAction
          mediaId="media-id"
          supported
          ocr={{ ...completedOcr, state: 'submitted' }}
          onQueued={vi.fn()}
        />,
      );
    });
    await act(async () => {
      container
        .querySelector('[aria-label="Більше дій"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Повторно запустити OCR',
      )?.disabled,
    ).toBe(true);
  });

  it('shows an error toast when reprocessing fails', async () => {
    const shell = document.createElement('div');
    shell.className = 'app-shell';
    shell.setAttribute('data-auth-user-roles', 'Admin');
    const container = document.createElement('div');
    shell.appendChild(container);
    document.body.appendChild(shell);
    const root = mountRoot(container);

    await act(async () => {
      root.render(
        <MediaReprocessAction mediaId="media-id" supported ocr={completedOcr} onQueued={vi.fn()} />,
      );
    });
    await act(async () => {
      container
        .querySelector('[aria-label="Більше дій"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    mocks.reprocessMediaOcr.mockRejectedValueOnce(new Error('network error'));
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Повторно запустити OCR')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.notify).toHaveBeenCalledWith({
      severity: 'error',
      message: 'Не вдалося повторно обробити медіа: network error',
    });
  });
});
