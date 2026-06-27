/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-pdf', () => {
  const pdfjs = { GlobalWorkerOptions: { workerSrc: '' } };

  function Document({
    children,
    onLoadSuccess,
  }: {
    children?: ReactNode;
    onLoadSuccess?: (event: { numPages: number }) => void;
  }) {
    return (
      <div data-document onClick={() => onLoadSuccess?.({ numPages: 2 })}>
        {children}
      </div>
    );
  }

  function Page({ pageNumber, scale }: { pageNumber: number; scale?: number }) {
    return <div data-page data-page-number={pageNumber} data-scale={scale} />;
  }

  return { pdfjs, Document, Page };
});

import { pdfjs } from 'react-pdf';
import { PdfDocumentPreview } from './PdfDocumentPreview';

describe('PdfDocumentPreview', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uses the bundled PDF.js worker and renders pages with scale', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<PdfDocumentPreview href="https://example.test/files/report.pdf" zoom={150} />);
    });

    expect(pdfjs.GlobalWorkerOptions.workerSrc).toContain('pdfjs-dist/build/pdf.worker.min.mjs');
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.querySelectorAll('[data-page]')).toHaveLength(0);

    await act(async () => {
      container.querySelector('[data-document]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const pages = container.querySelectorAll('[data-page]');
    expect(pages).toHaveLength(2);
    expect((pages[0] as HTMLElement)?.getAttribute('data-scale')).toBe('1.5');

    root.unmount();
  });
});

