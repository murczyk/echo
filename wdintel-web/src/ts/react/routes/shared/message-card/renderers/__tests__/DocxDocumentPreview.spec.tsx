/**
 * @vitest-environment happy-dom
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../workers/worker-client', () => ({
  runWorkerTask: vi.fn(async () => ({
    html: '<p>Docx preview</p>',
  })),
}));

vi.mock('../../docx/build-docx-html-document', () => ({
  buildDocxHtmlDocument: vi.fn((html: string) => html),
}));

vi.mock('../../docx/sanitize-docx-html', () => ({
  sanitizeDocxHtml: vi.fn((html: string) => html),
}));

import { runWorkerTask } from '../../workers/worker-client';
import { DocxDocumentPreview } from '../DocxDocumentPreview';

describe('DocxDocumentPreview', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('rejects oversized files before fetching the body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('should not fetch');
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <DocxDocumentPreview
          href="https://example.test/files/report.docx"
          zoom={100}
          sizeBytes={10 * 1024 * 1024 + 1}
        />,
      );
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Файл DOCX завеликий');

    root.unmount();
  });

  it('passes the fetched buffer to the worker as a transferable', async () => {
    const arrayBuffer = new ArrayBuffer(8);
    const arrayBufferSpy = vi.fn(async () => arrayBuffer);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers({
        'content-length': '8',
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      arrayBuffer: arrayBufferSpy,
    } as Response);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<DocxDocumentPreview href="https://example.test/files/report.docx" zoom={100} />);
    });

    expect(runWorkerTask).toHaveBeenCalledWith(
      expect.any(Function),
      { buffer: arrayBuffer },
      expect.any(AbortSignal),
      [arrayBuffer],
    );
    expect(container.querySelector('iframe')).not.toBeNull();

    root.unmount();
  });
});
