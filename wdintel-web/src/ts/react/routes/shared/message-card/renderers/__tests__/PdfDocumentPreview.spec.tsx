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
    file,
    options,
  }: {
    file?: { url: string };
    options?: { disableAutoFetch: boolean; disableStream: boolean };
    children?: ReactNode;
    onLoadSuccess?: (event: { numPages: number }) => void;
  }) {
    return (
      <div
        data-document
        data-url={file?.url}
        data-range-only={options?.disableAutoFetch && options?.disableStream}
        onClick={() =>
          onLoadSuccess?.({
            numPages: 10,
            getPage: vi.fn(async () => ({
              getViewport: () => ({ width: 800, height: 1200 }),
            })),
          } as never)
        }
      >
        {children}
      </div>
    );
  }

  function Page({
    pageNumber,
    width,
    onLoadError,
    onRenderError,
  }: {
    pageNumber: number;
    width?: number;
    onLoadError?: (error: Error) => void;
    onRenderError?: (error: Error) => void;
  }) {
    const error = () => Object.assign(new Error('Forbidden'), { status: 403 });
    return (
      <div
        data-page
        data-page-number={pageNumber}
        data-width={width}
        onClick={(event) => {
          event.stopPropagation();
          onLoadError?.(error());
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          onRenderError?.(error());
        }}
      />
    );
  }

  return { pdfjs, Document, Page };
});

import { pdfjs } from 'react-pdf';
import { PdfDocumentPreview } from '../PdfDocumentPreview.tsx';
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
    expect(container.querySelectorAll('[data-page]')).toHaveLength(3);
    expect(container.querySelector('[data-page]')?.getAttribute('data-width')).toBe('1380');

    await act(async () => {
      intersectionObserverInstances[0]?.triggerFirstObserved();
    });

    expect(container.querySelectorAll('[data-page]')).toHaveLength(4);

    await act(async () => {
      intersectionObserverInstances[1]?.triggerFirstObserved();
    });

    expect(container.querySelectorAll('[data-page]')).toHaveLength(5);

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
          sizeBytes={1_000_000_001}
        />,
      );
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Максимум: 1 ГБ.');

    root.unmount();
  });

  // PR #3830: large PDFs must reach PDF.js by URL without full-buffer copies.
  it.each([10 * 1024 * 1024 + 1, 1_000_000_000])(
    'opens %i bytes through range loading without reading the body',
    async (sizeBytes) => {
      const readBody = vi.fn(() => {
        throw new Error('must not buffer PDF');
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-length': String(sizeBytes), 'accept-ranges': 'bytes' }),
        arrayBuffer: readBody,
        blob: readBody,
      } as unknown as Response);
      const onError = vi.fn();
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const href = `https://example.test/files/accepted-${sizeBytes}.pdf`;
      await act(async () => {
        root.render(
          <PdfDocumentPreview href={href} zoom={100} sizeBytes={sizeBytes} onError={onError} />,
        );
      });
      expect(fetchSpy).toHaveBeenCalledWith(href, expect.objectContaining({ method: 'HEAD' }));
      expect(readBody).not.toHaveBeenCalled();
      expect(container.querySelector('[data-document]')?.getAttribute('data-url')).toBe(href);
      expect(container.querySelector('[data-document]')?.getAttribute('data-range-only')).toBe(
        'true',
      );
      expect(onError).not.toHaveBeenCalled();
      root.unmount();
    },
  );

  it('rejects oversized Content-Length despite smaller metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '1000000001', 'accept-ranges': 'bytes' }),
    } as Response);
    const onError = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <PdfDocumentPreview
          href="https://example.test/oversized.pdf"
          zoom={100}
          sizeBytes={8}
          onError={onError}
        />,
      );
    });
    expect(onError).toHaveBeenCalledWith(new Error('PDF_FILE_TOO_LARGE'));
    expect(container.querySelector('[data-document]')).toBeNull();
    root.unmount();
  });
  it('falls back to a cancelled range probe when the attachment route does not serve HEAD', async () => {
    const cancel = vi.fn(async () => {});
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: false, status: 405 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 206,
        headers: new Headers({ 'content-length': '1', 'content-range': 'bytes 0-0/1000000000' }),
        body: { cancel },
      } as unknown as Response);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<PdfDocumentPreview href="https://example.test/get-only.pdf" zoom={100} />);
    });
    expect(fetchSpy).toHaveBeenLastCalledWith(
      'https://example.test/get-only.pdf',
      expect.objectContaining({ headers: { Range: 'bytes=0-0' } }),
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-document]')?.getAttribute('data-url')).toBe(
      'https://example.test/get-only.pdf',
    );
    root.unmount();
  });
  it('opens a local PDF URL without an unsupported HEAD request', async () => {
    const cancel = vi.fn(async () => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, options) => {
      if (options?.method === 'HEAD') throw new TypeError('Failed to fetch');
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '8' }),
        body: { cancel },
      } as unknown as Response;
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const href = 'blob:https://example.test/local-pdf';
    await act(async () => {
      root.render(<PdfDocumentPreview href={href} zoom={100} />);
    });
    expect(fetchSpy).toHaveBeenCalledWith(href, expect.objectContaining({ method: 'GET' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-document]')?.getAttribute('data-url')).toBe(href);
    root.unmount();
  });
  it.each(['click', 'dblclick'])(
    'propagates a late page %s failure after document success',
    async (event) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-length': '1000000000', 'accept-ranges': 'bytes' }),
      } as Response);
      const onError = vi.fn();
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <PdfDocumentPreview href="https://example.test/late.pdf" zoom={100} onError={onError} />,
        );
      });
      await act(async () => {
        container
          .querySelector('[data-document]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(container.querySelectorAll('[data-page]')).toHaveLength(3);
      await act(async () => {
        container
          .querySelector('[data-page]')
          ?.dispatchEvent(new MouseEvent(event, { bubbles: true }));
      });
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
      expect(container.querySelector('[data-document]')).toBeNull();
      root.unmount();
    },
  );
});
