/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { replaceConcealmentArea } from './image-editor-raster';

class FabricObject {
  values: Record<string, unknown>;

  constructor(values: Record<string, unknown> = {}) {
    this.values = values;
    Object.assign(this, values);
  }

  get(key: string) {
    return this.values[key];
  }

  set(values: Record<string, unknown> | string, value?: unknown) {
    if (typeof values === 'string') this.values[values] = value;
    else Object.assign(this.values, values);
    Object.assign(this, this.values);
  }

  setCoords = vi.fn();
  setSrc = vi.fn();
}

class FabricLine extends FabricObject {
  constructor(points: number[], values: Record<string, unknown>) {
    super({ ...values, x1: points[0], y1: points[1], x2: points[2], y2: points[3] });
  }
}

class FabricImage extends FabricObject {
  static fromURL = vi.fn().mockResolvedValue(new FabricObject());
}

const fabric = {
  FabricImage,
  Rect: class extends FabricObject {},
  Circle: class extends FabricObject {},
  Line: FabricLine,
  Group: class extends FabricObject {
    constructor(objects: FabricObject[], values: Record<string, unknown>) {
      super(values);
      this.values.objects = objects;
    }

    getObjects() {
      return this.values.objects as FabricObject[];
    }
  },
};

function sourceImage() {
  return {
    width: 100,
    height: 80,
    getElement: () => document.createElement('img'),
  } as never;
}

function canvasFixture() {
  const objects: FabricObject[] = [];
  return {
    objects,
    add: vi.fn((...added: FabricObject[]) => objects.push(...added)),
    remove: vi.fn((object: FabricObject) => objects.splice(objects.indexOf(object), 1)),
    getObjects: () => objects,
    setActiveObject: vi.fn(),
    discardActiveObject: vi.fn(),
    requestRenderAll: vi.fn(),
  } as never;
}

describe('image editor raster operations #3099', () => {
  afterEach(() => vi.restoreAllMocks());

  it('blurs an expanded source canvas and crops it back to selected native bounds', async () => {
    const drawImage = vi.fn();
    const getContext = vi.fn(() => ({ drawImage, filter: '' }));
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = createElement(tagName) as HTMLCanvasElement;
      if (tagName === 'canvas') {
        Object.defineProperty(element, 'getContext', { value: getContext });
        Object.defineProperty(element, 'toDataURL', {
          value: () => 'data:image/png;base64,edited',
        });
      }
      return element;
    });
    const canvas = canvasFixture();
    await replaceConcealmentArea({
      canvas,
      sourceImage: {
        ...sourceImage(),
        get: (key: string) => (key === 'cropX' ? 100 : key === 'cropY' ? 50 : undefined),
      },
      fabric: fabric as never,
      bounds: { left: 20, top: 10, width: 30, height: 20 },
      mode: 'blur',
    });

    expect(drawImage).toHaveBeenCalledWith(
      expect.any(HTMLImageElement),
      104,
      50,
      62,
      46,
      0,
      0,
      62,
      46,
    );
    expect(drawImage).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      0,
      0,
      62,
      46,
      0,
      0,
      62,
      46,
    );
    expect(drawImage).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      16,
      10,
      30,
      20,
      0,
      0,
      30,
      20,
    );
  });

  it('redacts the complete normalized selection once #3099', async () => {
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = createElement(tagName) as HTMLCanvasElement;
      if (tagName === 'canvas')
        Object.defineProperty(element, 'getContext', {
          value: () => ({ drawImage: vi.fn(), fillRect: vi.fn() }),
        });
      return element;
    });
    const canvas = canvasFixture();
    await replaceConcealmentArea({
      canvas,
      sourceImage: sourceImage(),
      fabric: fabric as never,
      bounds: { left: 12.2, top: 7.1, width: 31.4, height: 20.2 },
      mode: 'redact',
    });
    expect(document.createElement).not.toHaveBeenCalledWith('canvas');
    expect(canvas.add).toHaveBeenCalledOnce();
    expect(canvas.add).toHaveBeenCalledWith(
      expect.objectContaining({
        left: 12,
        top: 7,
        width: 32,
        height: 21,
        fill: '#1f2937',
        editorRole: 'concealment',
        selectable: false,
        evented: false,
      }),
    );
  });

  it('pixelates the complete normalized selection at native scale #3099', async () => {
    const drawImage = vi.fn();
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = createElement(tagName) as HTMLCanvasElement;
      if (tagName === 'canvas') {
        Object.defineProperty(element, 'getContext', {
          value: () => ({ drawImage, imageSmoothingEnabled: true }),
        });
      }
      return element;
    });
    await replaceConcealmentArea({
      canvas: canvasFixture(),
      sourceImage: sourceImage(),
      fabric: fabric as never,
      bounds: { left: 11.2, top: 6.1, width: 31.4, height: 20.1 },
      mode: 'pixelate',
    });
    expect(drawImage).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 0, 0, 32, 21, 0, 0, 3, 2);
    expect(drawImage).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 0, 0, 3, 2, 0, 0, 32, 21);
  });

  it('rejects an over-budget raster operation before mutating the canvas #3099', async () => {
    const canvas = canvasFixture();
    await expect(
      replaceConcealmentArea({
        canvas,
        sourceImage: {
          width: 10_000,
          height: 10_000,
          getElement: () => document.createElement('img'),
        } as never,
        fabric: fabric as never,
        bounds: { left: 0, top: 0, width: 10_000, height: 10_000 },
        mode: 'pixelate',
      }),
    ).rejects.toThrow('Виділена область завелика для безпечної обробки');
    expect(canvas.add).not.toHaveBeenCalled();
  });

  it('composites an overlapping concealment into a later regional patch #3099', async () => {
    const fillRect = vi.fn();
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = createElement(tagName) as HTMLCanvasElement;
      if (tagName === 'canvas')
        Object.defineProperty(element, 'getContext', {
          value: () => ({ drawImage: vi.fn(), fillRect, imageSmoothingEnabled: true }),
        });
      return element;
    });
    const canvas = canvasFixture();
    canvas.objects.push(
      new FabricObject({
        editorRole: 'concealment',
        type: 'rect',
        left: 14,
        top: 9,
        width: 12,
        height: 10,
        fill: '#1f2937',
      }),
    );
    await replaceConcealmentArea({
      canvas,
      sourceImage: sourceImage(),
      fabric: fabric as never,
      bounds: { left: 10, top: 5, width: 24, height: 20 },
      mode: 'pixelate',
    });
    expect(fillRect).toHaveBeenCalledWith(4, 4, 12, 10);
  });
});
