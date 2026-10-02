/**
 * @vitest-environment happy-dom
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mui/material', () => ({
  CircularProgress: () => <span>loading</span>,
  IconButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Typography: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
}));
vi.mock('../../document-preview-utils.ts', () => ({ fetchCachedDocumentResponse: vi.fn() }));
vi.mock('../../workers/worker-client.ts', () => ({
  WorkerTaskTimeoutError: class WorkerTaskTimeoutError extends Error {},
  runWorkerTask: vi.fn(),
}));
vi.mock('../../attachment-preview/MessageCardAttachmentPreviewLayout.tsx', () => ({
  MessageCardAttachmentPreviewLayout: ({
    stage,
    header,
  }: {
    stage: React.ReactNode;
    header: React.ReactNode;
  }) => (
    <>
      {header}
      {stage}
    </>
  ),
}));
vi.mock('../../attachment-preview/MessageCardAttachmentPreviewHeader.tsx', () => ({
  MessageCardAttachmentPreviewHeader: () => <div>header</div>,
}));

import { ZipDocumentPreview } from '../ZipDocumentPreview';
import { fetchCachedDocumentResponse } from '../../document-preview-utils';
import { runWorkerTask } from '../../workers/worker-client';

const documentAttachment = {
  href: 'https://example.test/archive.zip',
  fileName: 'archive.zip',
  kind: 'zip' as const,
};
const navigation = { index: 0, count: 1, onNext: vi.fn(), onPrevious: vi.fn() };
const listing = {
  entries: [
    {
      index: 0,
      path: 'file.txt',
      compressedSize: 1,
      uncompressedSize: 1,
      compressionMethod: 0,
      localHeaderOffset: 0,
      crc32: 0,
      directory: false,
    },
  ],
  totalUncompressedSize: 1,
};
const legacyListing = {
  entries: [{ ...listing.entries[0], path: 'α' }],
  totalUncompressedSize: 1,
};

describe('ZipDocumentPreview', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('transfers the exact extraction buffer and suppresses a stale member download', async () => {
    const archive = new ArrayBuffer(8);
    let resolveExtract!: (value: ArrayBuffer) => void;
    vi.mocked(fetchCachedDocumentResponse).mockResolvedValue({
      buffer: archive,
      contentType: null,
      contentLength: 8,
    });
    vi.mocked(runWorkerTask).mockImplementation((_factory, request) =>
      request.type === 'list'
        ? Promise.resolve(listing)
        : (new Promise((resolve) => {
            resolveExtract = resolve as (value: ArrayBuffer) => void;
          }) as never),
    );
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.append(container);
    await act(async () => {
      root.render(
        <ZipDocumentPreview
          document={documentAttachment}
          navigation={navigation}
          onClose={vi.fn()}
          isDownloadStarting={() => false}
          onDownloadStart={() => true}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    const listCall = vi.mocked(runWorkerTask).mock.calls[0]!;
    expect((listCall[1] as { buffer: ArrayBuffer }).buffer).toBe(listCall[3]![0]);
    await act(async () => {
      container
        .querySelector('button[aria-label="Скачати file.txt"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const extractionCall = vi.mocked(runWorkerTask).mock.calls[1]!;
    expect((extractionCall[1] as { buffer: ArrayBuffer }).buffer).toBe(extractionCall[3]![0]);
    await act(async () => {
      root.render(
        <ZipDocumentPreview
          document={{ ...documentAttachment, href: 'https://example.test/other.zip' }}
          navigation={navigation}
          onClose={vi.fn()}
          isDownloadStarting={() => false}
          onDownloadStart={() => true}
        />,
      );
    });
    await act(async () => {
      resolveExtract(new ArrayBuffer(1));
      await Promise.resolve();
    });
    expect(createObjectURL).not.toHaveBeenCalled();
    root.unmount();
  });

  it('shows a distinct fetch timeout', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchCachedDocumentResponse).mockImplementation(
      (_href, _max, _message, signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        ) as never,
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.append(container);
    await act(async () => {
      root.render(
        <ZipDocumentPreview
          document={documentAttachment}
          navigation={navigation}
          onClose={vi.fn()}
          isDownloadStarting={() => false}
          onDownloadStart={() => true}
        />,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Час очікування завантаження ZIP вичерпано.');
    root.unmount();
  });

  it('keeps an activated download URL through unmount and revokes it later', async () => {
    vi.useFakeTimers();
    const archive = new ArrayBuffer(8);
    vi.mocked(fetchCachedDocumentResponse).mockResolvedValue({
      buffer: archive,
      contentType: null,
      contentLength: 8,
    });
    vi.mocked(runWorkerTask).mockImplementation(
      (_factory, request) =>
        Promise.resolve(request.type === 'list' ? listing : new ArrayBuffer(1)) as never,
    );
    const url = 'blob:test-download';
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(url);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.append(container);
    await act(async () => {
      root.render(
        <ZipDocumentPreview
          document={documentAttachment}
          navigation={navigation}
          onClose={vi.fn()}
          isDownloadStarting={() => false}
          onDownloadStart={() => true}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector('button[aria-label="Скачати file.txt"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    root.unmount();
    expect(revoke).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('revokes a URL immediately when download activation fails', async () => {
    const archive = new ArrayBuffer(8);
    vi.mocked(fetchCachedDocumentResponse).mockResolvedValue({
      buffer: archive,
      contentType: null,
      contentLength: 8,
    });
    vi.mocked(runWorkerTask).mockImplementation(
      (_factory, request) =>
        Promise.resolve(request.type === 'list' ? listing : new ArrayBuffer(1)) as never,
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:failed-download');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('download blocked');
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.append(container);
    await act(async () => {
      root.render(
        <ZipDocumentPreview
          document={documentAttachment}
          navigation={navigation}
          onClose={vi.fn()}
          isDownloadStarting={() => false}
          onDownloadStart={() => true}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector('button[aria-label="Скачати file.txt"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(revoke).toHaveBeenCalledWith('blob:failed-download');
    root.unmount();
  });

  it('uses a decoded legacy filename as the member download basename', async () => {
    const archive = new ArrayBuffer(8);
    vi.mocked(fetchCachedDocumentResponse).mockResolvedValue({
      buffer: archive,
      contentType: null,
      contentLength: 8,
    });
    vi.mocked(runWorkerTask).mockImplementation((_factory, request) =>
      Promise.resolve(request.type === 'list' ? legacyListing : new ArrayBuffer(1)),
    );
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:legacy-name');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.append(container);
    await act(async () => {
      root.render(
        <ZipDocumentPreview
          document={documentAttachment}
          navigation={navigation}
          onClose={vi.fn()}
          isDownloadStarting={() => false}
          onDownloadStart={() => true}
        />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector('button[aria-label="Скачати α"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(click.mock.instances[0]?.download).toBe('α');
    root.unmount();
  });
});
