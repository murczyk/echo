/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';

import { exportEditedImage } from './image-editor-export';

function canvasFixture() {
  const toBlob = vi.fn((callback: BlobCallback, type?: string) =>
    callback(new Blob(['edited'], { type })),
  );
  const canvas = {
    viewportTransform: [2, 0, 0, 2, 12, 16],
    setViewportTransform: vi.fn(),
    requestRenderAll: vi.fn(),
    toCanvasElement: vi.fn(() => ({ toBlob })),
  };
  return { canvas, toBlob };
}

describe('exportEditedImage', () => {
  it('exports at source dimensions independently of viewport zoom', async () => {
    const { canvas, toBlob } = canvasFixture();

    const file = await exportEditedImage({
      canvas: canvas as never,
      source: { blob: new Blob(), fileName: 'source.jpg', mimeType: 'image/jpeg' },
      sourceImage: { width: 4000, height: 3000 } as never,
      crop: null,
    });

    expect(canvas.toCanvasElement).toHaveBeenCalledWith(1, {
      left: 0,
      top: 0,
      width: 4000,
      height: 3000,
    });
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
    expect(file.name).toBe('source.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(canvas.setViewportTransform).toHaveBeenNthCalledWith(1, [1, 0, 0, 1, 0, 0]);
    expect(canvas.setViewportTransform).toHaveBeenLastCalledWith([2, 0, 0, 2, 12, 16]);
  });

  it('exports exactly the selected crop at native coordinates', async () => {
    const { canvas } = canvasFixture();
    const crop = {
      visible: true,
      getBoundingRect: () => ({ left: 20, top: 30, width: 640, height: 480 }),
    };

    await exportEditedImage({
      canvas: canvas as never,
      source: { blob: new Blob(), fileName: 'source.png', mimeType: 'image/png' },
      sourceImage: { width: 4000, height: 3000 } as never,
      crop: crop as never,
    });

    expect(canvas.toCanvasElement).toHaveBeenCalledWith(1, {
      left: 20,
      top: 30,
      width: 640,
      height: 480,
    });
    expect(crop.visible).toBe(true);
  });

  it('restores transient visibility and viewport when crop validation fails', async () => {
    const { canvas } = canvasFixture();
    const crop = {
      visible: false,
      get: () => 'crop',
      set(values: { visible: boolean }) {
        this.visible = values.visible;
      },
      getBoundingRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    };
    Object.assign(canvas, { getObjects: () => [crop] });

    await expect(
      exportEditedImage({
        canvas: canvas as never,
        source: { blob: new Blob(), fileName: 'source.png', mimeType: 'image/png' },
        sourceImage: { width: 4000, height: 3000 } as never,
        crop: crop as never,
      }),
    ).rejects.toThrow('Виберіть непорожню область для обрізання');

    expect(crop.visible).toBe(false);
    expect(canvas.setViewportTransform).toHaveBeenLastCalledWith([2, 0, 0, 2, 12, 16]);
    expect(canvas.requestRenderAll).toHaveBeenCalledOnce();
  });
});
