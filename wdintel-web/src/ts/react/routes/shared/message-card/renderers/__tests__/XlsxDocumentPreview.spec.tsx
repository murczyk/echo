/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../workers/worker-client', () => ({
  runWorkerTask: vi.fn(async () => ({
    sheets: [
      {
        name: 'Sheet1',
        rows: [['A1']],
        rowCount: 1,
        columnCount: 1,
        truncated: false,
      },
    ],
  })),
}));

vi.mock('../../xlsx/XlsxGrid', () => ({
  XlsxGrid: ({ rows }: { rows: string[][] }) => <div data-grid data-rows={rows.length} />,
}));

vi.mock('../../xlsx/XlsxSheetTabs', () => ({
  XlsxSheetTabs: ({ sheetNames }: { sheetNames: string[] }) => (
    <div data-tabs data-count={sheetNames.length} />
  ),
}));

import { XlsxDocumentPreview } from '../XlsxDocumentPreview';
import { runWorkerTask } from '../../workers/worker-client';

describe('XlsxDocumentPreview', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('rejects known oversized files before fetching the body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('should not fetch');
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <XlsxDocumentPreview
          href="https://example.test/files/report.xlsx"
          zoom={100}
          sizeBytes={10 * 1024 * 1024 + 1}
        />,
      );
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Файл XLSX завеликий');

    root.unmount();
  });

  it('rejects oversized responses before reading the array buffer', async () => {
    const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(8));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': `${10 * 1024 * 1024 + 1}` }),
      arrayBuffer: arrayBufferSpy,
    } as Response);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<XlsxDocumentPreview href="https://example.test/files/report.xlsx" zoom={100} />);
    });

    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Файл XLSX завеликий');

    root.unmount();
  });

  it('passes the fetched buffer to the worker as a transferable', async () => {
    const arrayBuffer = new ArrayBuffer(8);
    const arrayBufferSpy = vi.fn(async () => arrayBuffer);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers({
        'content-length': '8',
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      arrayBuffer: arrayBufferSpy,
    } as Response);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<XlsxDocumentPreview href="https://example.test/files/report.xlsx" zoom={100} />);
    });

    expect(runWorkerTask).toHaveBeenCalledWith(
      expect.any(Function),
      { buffer: arrayBuffer },
      expect.any(AbortSignal),
      [arrayBuffer],
    );

    root.unmount();
  });

  it('rejects oversized actual buffers even when content length is missing or lying', async () => {
    const largeBuffer = new ArrayBuffer(10 * 1024 * 1024 + 1);
    const arrayBufferSpy = vi.fn(async () => largeBuffer);
    const workerSpy = vi.mocked(runWorkerTask);
    workerSpy.mockClear();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers({
        'content-length': '1',
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(largeBuffer));
          controller.close();
        },
      }),
      arrayBuffer: arrayBufferSpy,
    } as Response);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <XlsxDocumentPreview href="https://example.test/files/report-actual.xlsx" zoom={100} />,
      );
    });

    expect(arrayBufferSpy).not.toHaveBeenCalled();
    expect(workerSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Файл XLSX завеликий');

    root.unmount();
  });
});
