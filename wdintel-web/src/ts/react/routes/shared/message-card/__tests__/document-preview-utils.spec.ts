import { afterEach, describe, expect, it, vi } from 'vitest';

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

  // @test-scope safeguard: prevents the document-preview cache from retaining more responses than its entry cap
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

  // @test-scope safeguard: prevents the document-preview cache from exceeding its retained byte budget
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
