import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpRequestError } from '../../../../services/api/client';
import {
  DOCUMENT_CACHE_LIMIT,
  DOCUMENT_CACHE_MAX_BYTES,
  fetchCachedDocumentResponse,
} from '../document-preview-utils';

function createResponse(byteLength: number): Response {
  const buffer = new ArrayBuffer(byteLength);
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: null,
    arrayBuffer: vi.fn(async () => buffer),
  } as unknown as Response;
}

describe('document preview response cache', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it.each(['request', 'body'] as const)(
    'allows another request after a disconnected %s without caching partial bytes',
    async (stage) => {
      const failure = new TypeError('Failed to fetch');
      const fetchMock = vi.fn(async () => createResponse(4));
      if (stage === 'request') fetchMock.mockRejectedValueOnce(failure);
      else
        fetchMock.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
              controller.error(failure);
            },
          }),
        } as Response);
      vi.stubGlobal('fetch', fetchMock);
      const href = `https://example.test/disconnected-${stage}.txt`;

      await expect(fetchCachedDocumentResponse(href, 4, 'too large')).rejects.toBeInstanceOf(
        HttpRequestError,
      );
      const recovered = await fetchCachedDocumentResponse(href, 4, 'too large');
      expect(recovered.buffer.byteLength).toBe(4);
      await fetchCachedDocumentResponse(href, 4, 'too large');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
  it('preserves an aborted request rather than offering a network retry', async () => {
    const aborted = new DOMException('Aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted));

    await expect(
      fetchCachedDocumentResponse('https://example.test/aborted.txt', 4, 'too large'),
    ).rejects.toBe(aborted);
  });
  it('does not retain archive bytes after their Blob URL is revoked', async () => {
    const href = URL.createObjectURL(new Blob(['private archive member']));
    try {
      const response = await fetchCachedDocumentResponse(href, 100, 'too large');
      expect(new TextDecoder().decode(response.buffer)).toBe('private archive member');
    } finally {
      URL.revokeObjectURL(href);
    }
    await expect(fetchCachedDocumentResponse(href, 100, 'too large')).rejects.toBeInstanceOf(
      HttpRequestError,
    );
  });
  it('evicts the least recently used response when the entry limit is reached', async () => {
    const fetchMock = vi.fn(async () => createResponse(1));
    vi.stubGlobal('fetch', fetchMock);
    const hrefs = Array.from(
      { length: DOCUMENT_CACHE_LIMIT },
      (_, index) => `https://example.test/lru-${index}.pdf`,
    );

    for (const href of hrefs) {
      await fetchCachedDocumentResponse(href, 1, 'too large');
    }

    await fetchCachedDocumentResponse(hrefs[0]!, 1, 'too large');
    await fetchCachedDocumentResponse('https://example.test/lru-overflow.pdf', 1, 'too large');
    await fetchCachedDocumentResponse(hrefs[1]!, 1, 'too large');

    expect(fetchMock).toHaveBeenCalledTimes(DOCUMENT_CACHE_LIMIT + 2);
  });
  it('evicts old responses when the retained byte budget is reached', async () => {
    const entryByteLength = Math.floor(DOCUMENT_CACHE_MAX_BYTES / 3) + 1;
    const fetchCounts = new Map<string, number>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (href: string) => {
        fetchCounts.set(href, (fetchCounts.get(href) ?? 0) + 1);
        return createResponse(entryByteLength);
      }),
    );
    const hrefs = ['byte-a.pdf', 'byte-b.pdf', 'byte-c.pdf'].map(
      (name) => `https://example.test/${name}`,
    );

    for (const href of hrefs) {
      await fetchCachedDocumentResponse(href, entryByteLength, 'too large');
    }
    await fetchCachedDocumentResponse(hrefs[0]!, entryByteLength, 'too large');

    expect(fetchCounts.get(hrefs[0]!)).toBe(2);
  });
});
