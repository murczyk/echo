/**
 * @vitest-environment happy-dom
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MarkdownDocumentPreview, TxtDocumentPreview } from '../../text-document-preview';

function buildReaderResponse(
  chunks: Uint8Array[],
  headers: HeadersInit = {},
): {
  response: Response;
  cancelSpy: ReturnType<typeof vi.fn>;
  releaseLockSpy: ReturnType<typeof vi.fn>;
} {
  const cancelSpy = vi.fn(async () => undefined);
  const releaseLockSpy = vi.fn();
  let currentIndex = 0;

  const reader = {
    read: vi.fn(async () => {
      if (currentIndex >= chunks.length) {
        return { done: true, value: undefined as Uint8Array | undefined };
      }
      const value = chunks[currentIndex];
      currentIndex += 1;
      return { done: false, value };
    }),
    cancel: cancelSpy,
    releaseLock: releaseLockSpy,
  };

  const response = {
    ok: true,
    headers: new Headers(headers),
    body: {
      getReader: () => reader,
    },
  } as unknown as Response;

  return { response, cancelSpy, releaseLockSpy };
}

function buildTextChunk(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function buildUtf16LeChunk(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = code >> 8;
  }
  return bytes;
}

function buildUtf16BeChunk(text: string): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xfe;
  bytes[1] = 0xff;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes[2 + index * 2] = code >> 8;
    bytes[3 + index * 2] = code & 0xff;
  }
  return bytes;
}

function buildWindows1251PrivetChunk(): Uint8Array {
  return new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
}

describe('text-document-preview', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows an error when the TXT stream exceeds the byte cap', async () => {
    const firstChunk = new Uint8Array(700_000);
    const secondChunk = new Uint8Array(400_000);
    const { response, cancelSpy, releaseLockSpy } = buildReaderResponse([firstChunk, secondChunk], {
      'content-type': 'text/plain; charset=utf-8',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TxtDocumentPreview href="https://example.test/files/notes.txt" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('завеликий');
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(releaseLockSpy).toHaveBeenCalledTimes(1);
    root.unmount();
  });

  it('shows an error when TXT fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network error'));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TxtDocumentPreview href="https://example.test/files/notes.txt" />);
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Помилка перегляду');
    expect(container.textContent).toContain('network error');
    root.unmount();
  });

  it('renders markdown safely without html, scripts, or images', async () => {
    const markdown = [
      '# Title',
      '',
      'Safe [external](https://example.test/page)',
      'Safe [local](/docs/guide)',
      'Safe [anchor](#top)',
      'Unsafe [protocol-relative](//example.test/page)',
      'Unsafe [backslash](/\\\\example.test/page)',
      'Unsafe [script](javascript:alert(1))',
      '',
      '<script>alert(1)</script>',
      '![ignored](https://example.test/image.png)',
    ].join('\n');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(buildTextChunk(markdown), {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<MarkdownDocumentPreview href="https://example.test/files/readme.md" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a[href="https://example.test/page"]')).not.toBeNull();
    expect(
      container.querySelector('a[href="https://example.test/page"]')?.getAttribute('target'),
    ).toBe('_blank');
    expect(
      container.querySelector('a[href="https://example.test/page"]')?.getAttribute('rel'),
    ).toContain('noopener');
    expect(container.querySelector('a[href="/docs/guide"]')).not.toBeNull();
    expect(container.querySelector('a[href="/docs/guide"]')?.getAttribute('target')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('a[href="//example.test/page"]')).toBeNull();
    expect(container.querySelector('a[href="/\\\\example.test/page"]')).toBeNull();
    expect(container.textContent).toContain('Unsafe protocol-relative');
    expect(container.textContent).toContain('Unsafe backslash');
    root.unmount();
  });

  it('renders utf-16le and utf-16be TXT fixtures', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const text = 'Привіт UTF-16';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(
      new Response(buildUtf16LeChunk(text), {
        headers: { 'content-type': 'text/plain; charset=utf-16le' },
      }),
    );

    await act(async () => {
      root.render(<TxtDocumentPreview href="https://example.test/files/notes.txt" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(text);
    root.unmount();

    const secondContainer = document.createElement('div');
    document.body.appendChild(secondContainer);
    const secondRoot = createRoot(secondContainer);

    fetchSpy.mockResolvedValueOnce(
      new Response(buildUtf16BeChunk(text), {
        headers: { 'content-type': 'text/plain; charset=utf-16be' },
      }),
    );

    await act(async () => {
      secondRoot.render(<TxtDocumentPreview href="https://example.test/files/notes-be.txt" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(secondContainer.textContent).toContain(text);
    secondRoot.unmount();
  });

  it('renders windows-1251 TXT and Markdown fixtures from extensionless URLs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const text = 'Привет';

    fetchSpy.mockResolvedValueOnce(
      new Response(buildWindows1251PrivetChunk(), {
        headers: { 'content-type': 'text/plain; charset=windows-1251' },
      }),
    );

    const txtContainer = document.createElement('div');
    document.body.appendChild(txtContainer);
    const txtRoot = createRoot(txtContainer);

    await act(async () => {
      txtRoot.render(<TxtDocumentPreview href="https://example.test/files/plain" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(txtContainer.textContent).toContain(text);
    txtRoot.unmount();

    fetchSpy.mockResolvedValueOnce(
      new Response(buildWindows1251PrivetChunk(), {
        headers: { 'content-type': 'text/markdown; charset=windows-1251' },
      }),
    );

    const markdownContainer = document.createElement('div');
    document.body.appendChild(markdownContainer);
    const markdownRoot = createRoot(markdownContainer);

    await act(async () => {
      markdownRoot.render(<MarkdownDocumentPreview href="https://example.test/files/readme" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(markdownContainer.textContent).toContain(text);
    markdownRoot.unmount();
  });

  it('honors case-variant charset parameters', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(buildWindows1251PrivetChunk(), {
        headers: { 'content-type': 'TEXT/PLAIN; CHARSET="WiNdOwS-1251"' },
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TxtDocumentPreview href="https://example.test/files/plain-case" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Привет');
    root.unmount();
  });

  it('falls back to UTF-8 for unsupported charset labels', async () => {
    const text = 'Привіт UTF-8';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(buildTextChunk(text), {
        headers: { 'content-type': 'text/plain; charset=x-unsupported-charset' },
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TxtDocumentPreview href="https://example.test/files/plain-unsupported" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(text);
    root.unmount();
  });

  it('prefers BOM over a contradictory declared charset', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(buildUtf16LeChunk('Привіт UTF-16'), {
        headers: { 'content-type': 'text/plain; charset=windows-1251' },
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TxtDocumentPreview href="https://example.test/files/plain-bom" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Привіт UTF-16');
    root.unmount();
  });

  it('rejects binary payloads with a declared legacy charset', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([0xcf, 0x00, 0xf0, 0x00]), {
        headers: { 'content-type': 'text/plain; charset=windows-1251' },
      }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<TxtDocumentPreview href="https://example.test/files/plain-binary" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('не текстовий файл');
    root.unmount();
  });
});
