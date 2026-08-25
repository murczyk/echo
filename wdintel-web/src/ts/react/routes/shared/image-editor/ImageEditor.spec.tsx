/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  canvasAdd: vi.fn(),
  canvasOptions: undefined as Record<string, unknown> | undefined,
  exportEditedImage: vi.fn(),
  sourceImage: {
    width: 200,
    height: 100,
    set: vi.fn(),
    get: vi.fn(),
  },
  fromURL: vi.fn(),
}));

vi.mock('./image-editor-export', () => ({ exportEditedImage: mocks.exportEditedImage }));
vi.mock('fabric', () => {
  class Canvas {
    width = 200;
    height = 100;
    viewportTransform = [1, 0, 0, 1, 0, 0];
    upperCanvasEl = document.createElement('canvas');
    backgroundImage: unknown;
    setDimensions = vi.fn();
    add = mocks.canvasAdd;
    on = vi.fn();
    off = vi.fn();
    dispose = vi.fn();
    getActiveObject = vi.fn();
    getObjects = vi.fn(() => []);
    discardActiveObject = vi.fn();
    requestRenderAll = vi.fn();
    setViewportTransform = vi.fn();
    setZoom = vi.fn();
    getZoom = vi.fn(() => 1);
    toJSON = vi.fn(() => ({}));
    constructor(_element: HTMLCanvasElement, options: Record<string, unknown>) {
      mocks.canvasOptions = options;
    }
  }
  return {
    Canvas,
    FabricImage: { fromURL: mocks.fromURL },
    IText: class IText {},
    Point: class Point {},
  };
});

import { ImageEditor } from './ImageEditor';

describe('ImageEditor initialization', () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source');

  afterEach(() => {
    vi.clearAllMocks();
    mocks.fromURL.mockResolvedValue(mocks.sourceImage);
    document.body.replaceChildren();
  });

  it('sets the source reference so Apply works immediately after initialization', async () => {
    mocks.fromURL.mockResolvedValue(mocks.sourceImage);
    mocks.exportEditedImage.mockResolvedValue(
      new File(['edited'], 'photo.png', { type: 'image/png' }),
    );
    const onApply = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    const resizeObserver = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = resizeObserver;
        disconnect = vi.fn();
      },
    );

    await act(async () => {
      root.render(
        <ImageEditor
          source={{
            blob: new Blob(['source'], { type: 'image/jpeg' }),
            fileName: 'photo.jpg',
            mimeType: 'image/jpeg',
          }}
          onCancel={vi.fn()}
          onApply={onApply}
        />,
      );
    });

    const apply = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Застосувати',
    ) as HTMLButtonElement;
    await vi.waitFor(() => expect(apply.disabled).toBe(false));
    await act(async () => apply.click());
    expect(mocks.exportEditedImage).toHaveBeenCalledWith(
      expect.objectContaining({ sourceImage: mocks.sourceImage }),
    );
    expect(mocks.sourceImage.set).toHaveBeenCalledWith(
      expect.objectContaining({ left: 0, scaleX: 1, scaleY: 1, top: 0 }),
    );
    expect(mocks.canvasAdd).not.toHaveBeenCalled();
    expect(mocks.canvasOptions).toMatchObject({ enableRetinaScaling: false });
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ file: expect.any(File) }));

    act(() => root.unmount());
  });

  it('keeps Apply disabled when Fabric cannot initialize the source image', async () => {
    mocks.fromURL.mockRejectedValueOnce(new Error('Не вдалося декодувати зображення'));
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);

    await act(async () => {
      root.render(
        <ImageEditor
          source={{ blob: new Blob(['source']), fileName: 'photo.jpg', mimeType: 'image/jpeg' }}
          onCancel={vi.fn()}
          onApply={vi.fn()}
        />,
      );
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain('Не вдалося декодувати зображення'),
    );
    const apply = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Застосувати',
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(
      (container.querySelector('button[aria-label="Лупа"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    act(() => root.unmount());
  });

  it('renders an export error once and keeps the loaded editor available for retry', async () => {
    mocks.exportEditedImage.mockRejectedValueOnce(new Error('Не вдалося експортувати зображення'));
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    await act(async () => {
      root.render(
        <ImageEditor
          source={{ blob: new Blob(['source']), fileName: 'photo.jpg', mimeType: 'image/jpeg' }}
          onCancel={vi.fn()}
          onApply={vi.fn()}
        />,
      );
    });
    const apply = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Застосувати',
    ) as HTMLButtonElement;
    await vi.waitFor(() => expect(apply.disabled).toBe(false));
    await act(async () => apply.click());
    await vi.waitFor(() =>
      expect(container.textContent?.match(/Не вдалося експортувати зображення/g)).toHaveLength(1),
    );
    expect(container.querySelector('canvas')).not.toBeNull();
    expect(apply.disabled).toBe(false);
    act(() => root.unmount());
  });
});
