/**
 * @vitest-environment happy-dom
 */
import { act, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-pdf', () => ({
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } },
  Document: () => null,
  Page: () => null,
}));

import { HttpRequestError, isAbortError } from '../../../../../services/api/client';
import { MarkdownDocumentPreview, TxtDocumentPreview } from '../../text-document-preview';
import { CsvDocumentPreview } from '../CsvDocumentPreview';
import { DocxDocumentPreview } from '../DocxDocumentPreview';
import { LegacyOfficeDocumentPreview } from '../LegacyOfficeDocumentPreview';
import { PdfDocumentPreview } from '../PdfDocumentPreview';
import { XlsxDocumentPreview } from '../XlsxDocumentPreview';

type PreviewProps = {
  href: string;
  zoom: number;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
};

const previews: [string, ComponentType<PreviewProps>][] = [
  ['csv', CsvDocumentPreview],
  ['xlsx', XlsxDocumentPreview],
  ['doc', (props) => <LegacyOfficeDocumentPreview {...props} kind="doc" />],
  ['xls', (props) => <LegacyOfficeDocumentPreview {...props} kind="xls" />],
  ['pdf', PdfDocumentPreview],
  ['docx', DocxDocumentPreview],
  ['txt', TxtDocumentPreview],
  ['md', MarkdownDocumentPreview],
];

const roots: Root[] = [];

describe('document preview lifecycle', () => {
  afterEach(async () => {
    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(previews)(
    '%s reports the original HTTP error while showing a local failure',
    async (kind, Preview) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
      const errors: unknown[] = [];
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      roots.push(root);

      await act(async () => {
        root.render(
          <Preview
            href={`/lifecycle/unauthorized.${kind}`}
            zoom={100}
            onError={(error) => errors.push(error)}
          />,
        );
      });

      expect(container.textContent).toContain('Помилка перегляду');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(HttpRequestError);
      expect((errors[0] as HttpRequestError).status).toBe(401);
    },
  );

  it.each(['doc', 'xls'] as const)(
    '%s reports its download deadline as a failure, not session cancellation',
    async (kind) => {
      vi.useFakeTimers();
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_href, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      );
      const errors: unknown[] = [];
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      roots.push(root);

      await act(async () => {
        root.render(
          <LegacyOfficeDocumentPreview
            href={`/lifecycle/timeout.${kind}`}
            kind={kind}
            zoom={100}
            onError={(error) => errors.push(error)}
          />,
        );
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      expect(container.textContent).toContain('Помилка перегляду');
      expect(errors).toHaveLength(1);
      expect(isAbortError(errors[0])).toBe(false);
    },
  );

  it.each(previews)(
    '%s cancels an in-flight request when the parent session aborts',
    async (kind, Preview) => {
      let requestSignal: AbortSignal | undefined;
      let rejectRequest: ((error: unknown) => void) | undefined;
      vi.spyOn(globalThis, 'fetch').mockImplementation((_href, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          rejectRequest = reject;
        });
      });
      const errors: unknown[] = [];
      const controller = new AbortController();
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      roots.push(root);

      await act(async () => {
        root.render(
          <Preview
            href={`/lifecycle/aborted.${kind}`}
            zoom={100}
            signal={controller.signal}
            onError={(error) => errors.push(error)}
          />,
        );
      });
      await act(async () => {
        controller.abort();
        rejectRequest?.(new DOMException('Aborted', 'AbortError'));
      });

      expect(requestSignal?.aborted).toBe(true);
      expect(errors).toEqual([]);
      expect(container.textContent).not.toContain('Помилка перегляду');
    },
  );

  it.each(previews)(
    '%s never starts a request for an already aborted session',
    async (kind, Preview) => {
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 404 }));
      const controller = new AbortController();
      controller.abort();
      const root = createRoot(document.createElement('div'));
      roots.push(root);

      await act(async () => {
        root.render(
          <Preview href={`/lifecycle/preaborted.${kind}`} zoom={100} signal={controller.signal} />,
        );
      });

      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
