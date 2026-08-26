/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  canvasAdd: vi.fn(),
  canvasOptions: undefined as Record<string, unknown> | undefined,
  canvas: undefined as { getActiveObject: ReturnType<typeof vi.fn> } | undefined,
  canvasSnapshot: 'initial',
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
    objects: unknown[] = [];
    add = vi.fn((object: unknown) => {
      this.objects.push(object);
      mocks.canvasAdd(object);
    });
    on = vi.fn();
    off = vi.fn();
    dispose = vi.fn();
    getActiveObject = vi.fn();
    getObjects = vi.fn(() => this.objects as never[]);
    remove = vi.fn((object: unknown) => {
      this.objects = this.objects.filter((candidate) => candidate !== object);
    });
    setActiveObject = vi.fn();
    discardActiveObject = vi.fn();
    requestRenderAll = vi.fn();
    setViewportTransform = vi.fn();
    setZoom = vi.fn();
    getZoom = vi.fn(() => 1);
    toJSON = vi.fn(() => ({ snapshot: mocks.canvasSnapshot }));
    constructor(_element: HTMLCanvasElement, options: Record<string, unknown>) {
      mocks.canvasOptions = options;
      mocks.canvas = this;
    }
  }
  class Rect {
    constructor(options: Record<string, unknown>) {
      Object.assign(this, options);
    }
    get(key: string) {
      return this[key as keyof this];
    }
    set(options: Record<string, unknown>) {
      Object.assign(this, options);
    }
    setControlsVisibility = vi.fn();
    setCoords = vi.fn();
    getBoundingRect() {
      return {
        left: Number(this.left ?? 0),
        top: Number(this.top ?? 0),
        width: Number(this.width ?? 0),
        height: Number(this.height ?? 0),
      };
    }
  }
  return {
    Canvas,
    FabricImage: { fromURL: mocks.fromURL },
    IText: class IText {},
    Rect,
    Point: class Point {},
  };
});

import { ImageEditor } from './ImageEditor';

describe('ImageEditor initialization', () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source');

  afterEach(() => {
    vi.clearAllMocks();
    mocks.fromURL.mockResolvedValue(mocks.sourceImage);
    mocks.canvasSnapshot = 'initial';
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
    expect((container.querySelector('button[aria-label="Ще"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    act(() => root.unmount());
  });

  it('cancels an idle editor on Escape', async () => {
    const onCancel = vi.fn();
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
          onCancel={onCancel}
          onApply={vi.fn()}
        />,
      );
    });
    await vi.waitFor(() =>
      expect(
        Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'Застосувати',
        ),
      ).toMatchObject({ disabled: false }),
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('exits Fabric text editing on Escape without cancelling the editor', async () => {
    const onCancel = vi.fn();
    const exitEditing = vi.fn();
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
          onCancel={onCancel}
          onApply={vi.fn()}
        />,
      );
    });
    await vi.waitFor(() => expect(mocks.canvas).toBeDefined());
    mocks.canvas?.getActiveObject.mockReturnValue({ isEditing: true, exitEditing });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(exitEditing).toHaveBeenCalledTimes(1);
    expect(mocks.canvas?.requestRenderAll).toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('cancels crop before cancelling the editor', async () => {
    const onCancel = vi.fn();
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
          onCancel={onCancel}
          onApply={vi.fn()}
        />,
      );
    });
    const crop = container.querySelector('button[aria-label="Обрізати"]') as HTMLButtonElement;
    await vi.waitFor(() => expect(crop.disabled).toBe(false));
    await act(async () => crop.click());

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('dismisses the discard warning on a second Escape', async () => {
    const onCancel = vi.fn();
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
          onCancel={onCancel}
          onApply={vi.fn()}
        />,
      );
    });
    const crop = container.querySelector('button[aria-label="Обрізати"]') as HTMLButtonElement;
    await vi.waitFor(() => expect(crop.disabled).toBe(false));
    await act(async () => crop.click());
    mocks.canvasSnapshot = 'crop';
    await act(async () => {
      (
        container.querySelector('button[aria-label="Застосувати обрізання"]') as HTMLButtonElement
      ).click();
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.textContent).toContain('Є незастосовані зміни');
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.textContent).not.toContain('Є незастосовані зміни');
    expect(onCancel).not.toHaveBeenCalled();
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
