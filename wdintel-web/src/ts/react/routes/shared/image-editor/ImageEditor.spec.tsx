/**
 * @vitest-environment happy-dom
 */
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  canvasAdd: vi.fn(),
  canvasConstructed: 0,
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
  loadImageEditorFonts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./image-editor-export', () => ({
  exportEditedImage: mocks.exportEditedImage,
  imageEditorOutputBasename: (fileName: string) => fileName.replace(/\.[^.]+$/, '') || 'image',
  imageEditorOutputExtension: (type: string) =>
    type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png',
  imageEditorOutputMimeType: (source: { mimeType: string }) => source.mimeType,
}));
vi.mock('./image-editor-source-validation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./image-editor-source-validation')>()),
  validateImageEditorSource: vi.fn().mockResolvedValue({ width: 200, height: 100 }),
}));
vi.mock('./image-editor-font', () => ({
  loadImageEditorFonts: mocks.loadImageEditorFonts,
}));
vi.mock('fabric', () => {
  const classes = new Map<string, unknown>();
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
      mocks.canvasConstructed += 1;
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
    FabricObject: class FabricObject {},
    IText: class IText {
      static cacheProperties: string[] = [];
    },
    Rect,
    Point: class Point {},
    classRegistry: {
      getClass: (name: string) => classes.get(name),
      setClass: (value: { type: string }) => classes.set(value.type, value),
    },
  };
});

import { ImageEditor } from './ImageEditor';

describe('ImageEditor initialization', () => {
  const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source');
  let consoleError: ReturnType<typeof vi.spyOn> | undefined;

  afterEach(() => {
    consoleError?.mockRestore();
    consoleError = undefined;
    vi.clearAllMocks();
    mocks.fromURL.mockResolvedValue(mocks.sourceImage);
    mocks.loadImageEditorFonts.mockResolvedValue(undefined);
    mocks.canvasConstructed = 0;
    mocks.canvasSnapshot = 'initial';
    document.body.replaceChildren();
  });

  it('sets the source reference so Apply works immediately after initialization', async () => {
    mocks.fromURL.mockResolvedValue(mocks.sourceImage);
    mocks.exportEditedImage.mockResolvedValue(
      new File(['edited'], 'photo.png', { type: 'image/png' }),
    );
    const onSaveReplacement = vi.fn();
    const onSaveAsNew = vi.fn();
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
          onSaveReplacement={onSaveReplacement}
          onSaveAsNew={onSaveAsNew}
        />,
      );
    });

    const apply = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Зберегти',
    ) as HTMLButtonElement;
    await vi.waitFor(() => expect(apply.disabled).toBe(false));
    await act(async () => apply.click());
    expect(onSaveReplacement).not.toHaveBeenCalled();
    await act(async () =>
      (
        Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent === 'Замінити',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(mocks.exportEditedImage).toHaveBeenCalledWith(
      expect.objectContaining({ sourceImage: mocks.sourceImage }),
    );
    expect(mocks.sourceImage.set).toHaveBeenCalledWith(
      expect.objectContaining({ left: 0, scaleX: 1, scaleY: 1, top: 0 }),
    );
    expect(mocks.canvasAdd).not.toHaveBeenCalled();
    expect(mocks.canvasOptions).toMatchObject({ enableRetinaScaling: false });
    expect(onSaveReplacement).toHaveBeenCalledWith(
      expect.objectContaining({ file: expect.any(File) }),
    );

    act(() => root.unmount());
  });

  it('selects pixelation as the default concealment mode', async () => {
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
          onSaveReplacement={vi.fn()}
          onSaveAsNew={vi.fn()}
        />,
      );
    });
    const conceal = container.querySelector('button[aria-label="Розмиття"]') as HTMLButtonElement;
    await vi.waitFor(() => expect(conceal.disabled).toBe(false));
    await act(async () => conceal.click());

    const pixelate = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Пікселізація',
    );
    expect(pixelate?.getAttribute('aria-pressed')).toBe('true');

    act(() => root.unmount());
  });

  it('stops initialization when unmounted while fonts load #3448', async () => {
    let resolveFonts!: () => void;
    mocks.loadImageEditorFonts.mockImplementation(
      () => new Promise<void>((resolve) => (resolveFonts = resolve)),
    );
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
          onSaveReplacement={vi.fn()}
          onSaveAsNew={vi.fn()}
        />,
      );
    });
    await vi.waitFor(() => expect(mocks.loadImageEditorFonts).toHaveBeenCalledOnce());

    act(() => root.unmount());
    await act(async () => {
      resolveFonts();
      await Promise.resolve();
    });

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(mocks.fromURL).not.toHaveBeenCalled();
    expect(mocks.canvasConstructed).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('discards rejected font loading after unmount #3448', async () => {
    let rejectFonts!: (cause: Error) => void;
    mocks.loadImageEditorFonts.mockImplementation(
      () => new Promise<void>((_resolve, reject) => (rejectFonts = reject)),
    );
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
          onSaveReplacement={vi.fn()}
          onSaveAsNew={vi.fn()}
        />,
      );
    });
    await vi.waitFor(() => expect(mocks.loadImageEditorFonts).toHaveBeenCalledOnce());

    act(() => root.unmount());
    await act(async () => {
      rejectFonts(new Error('Шрифти недоступні'));
      await Promise.resolve();
    });

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(mocks.fromURL).not.toHaveBeenCalled();
    expect(mocks.canvasConstructed).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
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
          onSaveReplacement={vi.fn()}
          onSaveAsNew={vi.fn()}
        />,
      );
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain('Не вдалося декодувати зображення'),
    );
    const apply = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Зберегти',
    ) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect((container.querySelector('button[aria-label="Ще"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    act(() => root.unmount());
  });

  it('saves a user-provided basename as a new image', async () => {
    mocks.exportEditedImage.mockImplementation(
      async ({ outputBasename }) =>
        new File(['edited'], `${outputBasename}.jpg`, { type: 'image/jpeg' }),
    );
    const onSaveAsNew = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    await act(async () => {
      root.render(
        <ImageEditor
          source={{
            blob: new Blob(['source']),
            fileName: 'battle.map.jpg',
            mimeType: 'image/jpeg',
          }}
          onCancel={vi.fn()}
          onSaveReplacement={vi.fn()}
          onSaveAsNew={onSaveAsNew}
        />,
      );
    });
    const saveAsNew = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Зберегти як новий',
    ) as HTMLButtonElement;
    await vi.waitFor(() => expect(saveAsNew.disabled).toBe(false));
    await act(async () => saveAsNew.click());
    const input = document.querySelector('input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'edited.JPG',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      (
        Array.from(document.querySelectorAll('button'))
          .filter((button) => button.textContent === 'Зберегти як новий')
          .at(-1) as HTMLButtonElement
      ).click(),
    );
    await vi.waitFor(() =>
      expect(onSaveAsNew).toHaveBeenCalledWith(
        expect.objectContaining({ file: expect.objectContaining({ name: 'edited.jpg' }) }),
      ),
    );
    expect(mocks.exportEditedImage).toHaveBeenCalledWith(
      expect.objectContaining({ outputBasename: 'edited' }),
    );
    act(() => root.unmount());
  });

  it('closes replacement confirmation on Escape without closing the editor', async () => {
    const onCancel = vi.fn();
    const onSaveReplacement = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    document.body.appendChild(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <ImageEditor
            source={{ blob: new Blob(['source']), fileName: 'photo.jpg', mimeType: 'image/jpeg' }}
            onCancel={onCancel}
            onSaveReplacement={onSaveReplacement}
            onSaveAsNew={vi.fn()}
          />
        </StrictMode>,
      );
    });
    const save = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Зберегти',
    ) as HTMLButtonElement;
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    await act(async () => save.click());
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Замінити поточне зображення?'),
    );
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).not.toContain('Замінити поточне зображення?'),
    );
    expect(onSaveReplacement).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Редактор зображення"]')).not.toBeNull();
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
          onSaveReplacement={vi.fn()}
          onSaveAsNew={vi.fn()}
        />,
      );
    });
    await vi.waitFor(() =>
      expect(
        Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'Зберегти',
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
          onSaveReplacement={vi.fn()}
          onSaveAsNew={vi.fn()}
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

  it('keeps editor cancellation behind text-editing Escape handling #3448', async () => {
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
    const activeText = { isEditing: true, exitEditing: vi.fn() };
    mocks.canvas?.getActiveObject.mockReturnValue(activeText);

    await act(async () => {
      root.render(
        <ImageEditor
          source={{ blob: new Blob(['source']), fileName: 'photo.jpg', mimeType: 'image/jpeg' }}
          onCancel={onCancel}
          onSaveReplacement={vi.fn()}
          onSaveAsNew={vi.fn()}
        />,
      );
    });
    await vi.waitFor(() => expect(mocks.canvas).toBeDefined());
    mocks.canvas?.getActiveObject.mockReturnValue(activeText);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(activeText.exitEditing).toHaveBeenCalledOnce();
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
          onSaveReplacement={vi.fn()}
          onSaveAsNew={vi.fn()}
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
          onSaveReplacement={vi.fn()}
          onSaveAsNew={vi.fn()}
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
    expect(document.body.textContent).toContain('Відкинути зміни зображення?');
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.textContent).not.toContain('Відкинути зміни зображення?');
    expect(onCancel).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('keeps replacement confirmation open with a visible save error after a failed callback', async () => {
    const onSaveReplacement = vi.fn().mockRejectedValue(new Error('Не вдалося зберегти вкладення'));
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
          onSaveReplacement={onSaveReplacement}
          onSaveAsNew={vi.fn()}
        />,
      );
    });
    const apply = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Зберегти',
    ) as HTMLButtonElement;
    await vi.waitFor(() => expect(apply.disabled).toBe(false));
    await act(async () => apply.click());
    await act(async () =>
      (
        Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent === 'Замінити',
        ) as HTMLButtonElement
      ).click(),
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Не вдалося зберегти вкладення'),
    );
    expect(document.body.textContent).toContain('Замінити поточне зображення?');
    expect(container.querySelector('canvas')).not.toBeNull();
    expect(
      Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Замінити',
      ),
    ).toMatchObject({ disabled: false });
    act(() => root.unmount());
  });
});
