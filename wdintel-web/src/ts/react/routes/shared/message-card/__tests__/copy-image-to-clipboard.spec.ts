/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canCopyImageToClipboard, copyImageToClipboard } from '../copy-image-to-clipboard';

class FakeClipboardItem {
  static supports = vi.fn((type: string) => type.startsWith('image/'));

  items: Record<string, Blob | Promise<Blob>>;

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

  // @test-scope safeguard: prevents a loaded image copy from losing its rendered PNG data
  it('copies the canvas PNG blob when the preview image is loaded', async () => {
    const image = createLoadedImage();
    const write = vi.fn().mockImplementation(async ([item]: [FakeClipboardItem]) => {
      await item.items['image/png'];
    });
    const drawImage = vi.fn();
    let resolveToBlob: ((blob: Blob) => void) | null = null;
    const canvasBlob = new Promise<Blob>((resolve) => {
      resolveToBlob = resolve;
    });
    const toBlob = vi.fn((callback: BlobCallback) => {
      canvasBlob.then((blob) => callback?.(blob));
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

    const copyPromise = copyImageToClipboard(image, 'https://example.test/image.png');
    await Promise.resolve();

    expect(write).toHaveBeenCalledTimes(1);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 12, 8);
    const clipboardItem = write.mock.calls[0]?.[0]?.[0] as FakeClipboardItem;
    expect(clipboardItem.items['image/png']).toBeInstanceOf(Promise);

    resolveToBlob?.(new Blob(['png'], { type: 'image/png' }));
    await copyPromise;

    await expect(clipboardItem.items['image/png']).resolves.toBeInstanceOf(Blob);
  });

  // @test-scope safeguard: preserves the browser user-activation window while canvas conversion is pending
  it('calls clipboard.write before the canvas blob promise resolves', async () => {
    const image = createLoadedImage();
    const write = vi.fn().mockResolvedValue(undefined);
    const drawImage = vi.fn();
    let resolveToBlob: ((blob: Blob) => void) | null = null;
    const canvasBlob = new Promise<Blob>((resolve) => {
      resolveToBlob = resolve;
    });
    const toBlob = vi.fn((callback: BlobCallback, type?: string) => {
      canvasBlob.then((blob) => callback?.(blob));
      return type;
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

    const copyPromise = copyImageToClipboard(image, 'https://example.test/image.png');
    await Promise.resolve();

    expect(write).toHaveBeenCalledTimes(1);

    resolveToBlob?.(new Blob(['png'], { type: 'image/png' }));
    await copyPromise;

    expect(write).toHaveBeenCalledTimes(1);
  });

  // @test-scope safeguard: prevents a canvas-export failure from losing an image copy action
  it('falls back to the fetched blob when canvas export fails', async () => {
    const image = createLoadedImage();
    const write = vi.fn().mockImplementation(async ([item]: [FakeClipboardItem]) => {
      await item.items['image/png'];
    });
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
    expect(write).toHaveBeenCalledTimes(2);
    const clipboardItem = write.mock.calls[1]?.[0]?.[0] as FakeClipboardItem;
    expect(clipboardItem.items['image/jpeg']).toBeInstanceOf(Blob);
    expect(clipboardItem.items['image/jpeg'].type).toBe('image/jpeg');
  });

  // @test-scope safeguard: retries image copying with the fetched source after a clipboard write failure
  it('falls back to fetch when clipboard write fails', async () => {
    const image = createLoadedImage();
    let writeCalls = 0;
    const write = vi.fn().mockImplementation(async () => {
      writeCalls += 1;
      if (writeCalls === 1) {
        throw new Error('clipboard write denied');
      }
    });
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }),
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await copyImageToClipboard(image, 'https://example.test/image.png');

    expect(fetchMock).toHaveBeenCalledWith('https://example.test/image.png', {
      credentials: 'include',
    });
    expect(write).toHaveBeenCalledTimes(2);
  });

  // @test-scope safeguard: prevents non-image response content from entering the image clipboard
  it('rejects non-image fetched content even when ClipboardItem supports it', async () => {
    const image = createLoadedImage();
    const write = vi.fn().mockImplementation(async ([item]: [FakeClipboardItem]) => {
      await item.items['image/png'];
    });
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
      blob: async () => new Blob(['<html></html>'], { type: 'text/html' }),
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html' : null),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(copyImageToClipboard(image, 'https://example.test/image.html')).rejects.toThrow(
      'Копіювання зображень недоступне.',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  // @test-scope safeguard: prevents unavailable image-copy capability from being presented as executable
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
