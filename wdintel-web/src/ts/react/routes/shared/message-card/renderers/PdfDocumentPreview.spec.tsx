/**
 * @vitest-environment happy-dom
 */
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

const intersectionObserverInstances: MockIntersectionObserver[] = [];

class MockIntersectionObserver {
  private readonly callback: IntersectionObserverCallback;
  private readonly observedElements = new Set<Element>();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    intersectionObserverInstances.push(this);
  }

  observe(element: Element) {
    this.observedElements.add(element);
  }

  unobserve(element: Element) {
    this.observedElements.delete(element);
  }

  disconnect() {
    this.observedElements.clear();
  }

  triggerFirstObserved() {
    const element = this.observedElements.values().next().value;
    if (element == null) return;

    this.callback(
      [
        {
          target: element,
          isIntersecting: true,
          intersectionRatio: 1,
          time: 0,
          boundingClientRect: {} as DOMRectReadOnly,
          intersectionRect: {} as DOMRectReadOnly,
          rootBounds: null,
        },
      ],
      this as unknown as IntersectionObserver,
    );
  }
}

globalThis.IntersectionObserver =
  MockIntersectionObserver as unknown as typeof IntersectionObserver;

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
      <div data-document onClick={() => onLoadSuccess?.({ numPages: 10 })}>
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
    intersectionObserverInstances.splice(0, intersectionObserverInstances.length);
    vi.restoreAllMocks();
  });

  it('uses the bundled PDF.js worker and renders pages lazily', async () => {
    const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(8));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers({
        'content-length': '8',
        'content-type': 'application/pdf',
      }),
      arrayBuffer: arrayBufferSpy,
    } as Response);
    vi.spyOn(globalThis.URL, 'createObjectURL').mockReturnValue('blob:https://example.test/pdf');
    vi.spyOn(globalThis.URL, 'revokeObjectURL').mockImplementation(() => {});

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
      container
        .querySelector('[data-document]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelectorAll('[data-pdf-page-shell]')).toHaveLength(10);
    expect(container.querySelectorAll('[data-page]')).toHaveLength(0);

    await act(async () => {
      intersectionObserverInstances[0]?.triggerFirstObserved();
    });

    const initialPages = container.querySelectorAll('[data-page]');
    expect(initialPages).toHaveLength(1);
    expect((initialPages[0] as HTMLElement)?.getAttribute('data-scale')).toBe('1.5');

    await act(async () => {
      intersectionObserverInstances[1]?.triggerFirstObserved();
    });

    expect(container.querySelectorAll('[data-page]')).toHaveLength(2);

    root.unmount();
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
        <PdfDocumentPreview
          href="https://example.test/files/report.pdf"
          zoom={100}
          sizeBytes={10 * 1024 * 1024 + 1}
        />,
      );
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Файл PDF завеликий');

    root.unmount();
  });
});
