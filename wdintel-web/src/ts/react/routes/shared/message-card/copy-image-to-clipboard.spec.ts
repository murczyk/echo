/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canCopyImageToClipboard, copyImageToClipboard } from './copy-image-to-clipboard';

class FakeClipboardItem {
  static supports = vi.fn((type: string) => type.startsWith('image/'));

  items: Record<string, Blob>;

  constructor(items: Record<string, Blob>) {
    this.items = items;
  }
}

function createLoadedImage(): HTMLImageElement {
  const image = document.createElement('img');
  Object.defineProperty(image, 'naturalWidth', { value: 12 });
  Object.defineProperty(image, 'naturalHeight', { value: 8 });
  return image;
}

describe('copyImageToClipboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('copies the canvas PNG blob when the preview image is loaded', async () => {
    const image = createLoadedImage();
    const write = vi.fn().mockResolvedValue(undefined);
    const drawImage = vi.fn();
    const toBlob = vi.fn((callback: BlobCallback, type?: string) => {
      callback?.(new Blob(['png'], { type }));
    });
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, 'createElement');
    createElement.mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage }) as CanvasRenderingContext2D,
          toBlob,
        } as never;
      }

      return originalCreateElement(tagName);
    }) as typeof document.createElement);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);

    await copyImageToClipboard(image, 'https://example.test/image.png');

    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 12, 8);
    expect(write).toHaveBeenCalledTimes(1);
    const clipboardItem = write.mock.calls[0]?.[0]?.[0] as FakeClipboardItem;
    expect(clipboardItem.items['image/png']).toBeInstanceOf(Blob);
    expect(clipboardItem.items['image/png'].type).toBe('image/png');
  });

  it('falls back to the fetched blob when canvas export fails', async () => {
    const image = createLoadedImage();
    const write = vi.fn().mockResolvedValue(undefined);
    const toBlob = vi.fn((callback: BlobCallback) => {
      callback?.(null);
    });
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, 'createElement');
    createElement.mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: vi.fn() }) as CanvasRenderingContext2D,
          toBlob,
        } as never;
      }

      return originalCreateElement(tagName);
    }) as typeof document.createElement);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await copyImageToClipboard(image, 'https://example.test/image.jpg');

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/image.jpg', {
      credentials: 'include',
    });
    expect(write).toHaveBeenCalledTimes(1);
    const clipboardItem = write.mock.calls[0]?.[0]?.[0] as FakeClipboardItem;
    expect(clipboardItem.items['image/jpeg']).toBeInstanceOf(Blob);
    expect(clipboardItem.items['image/jpeg'].type).toBe('image/jpeg');
  });

  it('does not fall back to fetch when clipboard write fails', async () => {
    const image = createLoadedImage();
    const write = vi.fn().mockRejectedValue(new Error('clipboard write denied'));
    const drawImage = vi.fn();
    const toBlob = vi.fn((callback: BlobCallback, type?: string) => {
      callback?.(new Blob(['png'], { type }));
    });
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, 'createElement');
    createElement.mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage }) as CanvasRenderingContext2D,
          toBlob,
        } as never;
      }

      return originalCreateElement(tagName);
    }) as typeof document.createElement);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    });
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(copyImageToClipboard(image, 'https://example.test/image.png')).rejects.toThrow(
      'clipboard write denied',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('reports image copying as unavailable when the browser lacks clipboard support', () => {
    const image = createLoadedImage();
    vi.stubGlobal('ClipboardItem', undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: undefined },
    });

    expect(canCopyImageToClipboard(image)).toBe(false);
  });
});
