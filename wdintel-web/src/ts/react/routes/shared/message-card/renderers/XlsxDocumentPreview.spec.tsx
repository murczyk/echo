/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../workers/worker-client', () => ({
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

vi.mock('../xlsx/XlsxGrid', () => ({
  XlsxGrid: ({ rows }: { rows: string[][] }) => <div data-grid data-rows={rows.length} />,
}));

vi.mock('../xlsx/XlsxSheetTabs', () => ({
  XlsxSheetTabs: ({ sheetNames }: { sheetNames: string[] }) => <div data-tabs data-count={sheetNames.length} />,
}));

import { XlsxDocumentPreview } from './XlsxDocumentPreview';

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
      root.render(<XlsxDocumentPreview href="https://example.test/files/report.xlsx" zoom={100} sizeBytes={10 * 1024 * 1024 + 1} />);
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
});
