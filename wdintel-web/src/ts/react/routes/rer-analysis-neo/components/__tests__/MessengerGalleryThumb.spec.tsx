/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageMediaInfo } from '../../../../../../Bindings';
import { clearGalleryThumbnailCache } from '../../messenger-gallery-thumbnails';
import { GalleryThumbImage } from '../MessengerGalleryThumb';

const media = {
  id: 'm1',
  href: '/api/messenger/media/m1',
  contentType: 'image/jpeg',
  sizeBytes: 500 * 1024,
} as MessageMediaInfo;

const answer = (status: number) =>
  ({
    ok: status < 300,
    status,
    headers: new Headers(),
    blob: async () => new Blob(['jpeg']),
  }) as Response;

describe('GalleryThumbImage', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn();
  const image = () => container.querySelector('img');
  const settle = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const mount = (video = false, info: MessageMediaInfo = media) =>
    act(async () => root.render(<GalleryThumbImage media={info} video={video} />));

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:thumb');
    URL.revokeObjectURL = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    clearGalleryThumbnailCache();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the thumbnail of the route once it is downloaded', async () => {
    fetchMock.mockResolvedValue(answer(200));
    await mount();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/messenger/media/m1/thumbnail');
    expect(image()?.getAttribute('src')).toBe('blob:thumb');
  });

  it('shows a cached thumbnail at once on a second mount, without a request', async () => {
    fetchMock.mockResolvedValue(answer(200));
    await mount();
    act(() => root.unmount());
    root = createRoot(container);
    await mount();
    expect(image()?.getAttribute('src')).toBe('blob:thumb');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('waits for a thumbnail that is still being made', async () => {
    fetchMock.mockResolvedValueOnce(answer(202)).mockResolvedValue(answer(200));
    await mount();
    expect(image()).toBeNull();
    await settle(1000);
    expect(image()?.getAttribute('src')).toBe('blob:thumb');
  });

  it('falls back to the original of a photo when the thumbnail never comes, then gives up', async () => {
    fetchMock.mockResolvedValue(answer(422));
    await mount();
    expect(image()?.getAttribute('src')).toBe('/api/messenger/media/m1');
    act(() => void image()?.dispatchEvent(new Event('error')));
    expect(image()).toBeNull();
    expect(container.querySelector('[aria-label="Зображення недоступне"]')).not.toBeNull();
  });

  it('has no original to fall back to for a video', async () => {
    fetchMock.mockResolvedValue(answer(422));
    await mount(true);
    expect(image()).toBeNull();
    expect(container.querySelector('[aria-label="Зображення недоступне"]')).not.toBeNull();
  });

  it('does not pull an original that is too big for a gallery tile, and says why', async () => {
    fetchMock.mockResolvedValue(answer(422));
    await mount(false, { ...media, sizeBytes: 5 * 1024 * 1024 });
    expect(image()).toBeNull();
    expect(container.querySelector('[title*="завеликий"]')).not.toBeNull();
  });

  it('shows the failure when the thumbnail arrives but cannot be drawn', async () => {
    fetchMock.mockResolvedValue(answer(200));
    await mount();
    act(() => void image()?.dispatchEvent(new Event('error')));
    expect(image()).toBeNull();
    expect(container.querySelector('[aria-label="Зображення недоступне"]')).not.toBeNull();
  });

  it('explains a failed video thumbnail in a tooltip', async () => {
    fetchMock.mockResolvedValue(answer(422));
    await mount(true);
    expect(container.querySelector('[title*="Мініатюру відео"]')).not.toBeNull();
  });

  describe('a small original instead of a thumbnail', () => {
    const small = { ...media, sizeBytes: 150 * 1024 };

    it('is requested for a JPEG photo of 200 KB or less, and no thumbnail is asked for', async () => {
      fetchMock.mockResolvedValue(answer(200));
      await mount(false, small);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('/api/messenger/media/m1');
      expect(image()?.getAttribute('src')).toBe('blob:thumb');
    });

    it('is not used above the limit, for a video, or for another image type', async () => {
      fetchMock.mockResolvedValue(answer(200));
      await mount(false, { ...small, sizeBytes: 200 * 1024 + 1 });
      expect(fetchMock.mock.calls[0][0]).toBe('/api/messenger/media/m1/thumbnail');
      act(() => root.unmount());
      clearGalleryThumbnailCache();
      root = createRoot(container);
      await mount(true, small);
      expect(fetchMock.mock.calls[1][0]).toBe('/api/messenger/media/m1/thumbnail');
      act(() => root.unmount());
      clearGalleryThumbnailCache();
      root = createRoot(container);
      await mount(false, { ...small, contentType: 'image/png' });
      expect(fetchMock.mock.calls[2][0]).toBe('/api/messenger/media/m1/thumbnail');
    });

    it('shows the failure tile when the original does not come, without falling back to itself', async () => {
      fetchMock.mockResolvedValue(answer(422));
      await mount(false, small);
      expect(image()).toBeNull();
      expect(container.querySelector('[aria-label="Зображення недоступне"]')).not.toBeNull();
    });
  });
});
