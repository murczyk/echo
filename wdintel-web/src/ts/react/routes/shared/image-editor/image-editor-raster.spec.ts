/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildSafeRaster, replaceConcealmentArea } from './image-editor-raster';

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
    const created: HTMLCanvasElement[] = [];
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = createElement(tagName) as HTMLCanvasElement;
      if (tagName === 'canvas') {
        created.push(element);
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
      sourceImage: sourceImage(),
      fabric: fabric as never,
      bounds: { left: 20, top: 10, width: 30, height: 20 },
      mode: 'blur',
    });

    expect(created).toHaveLength(3);
    expect(drawImage).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      4,
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

  it('uses the cumulative cropped source rectangle for subsequent concealment', () => {
    const drawImage = vi.fn();
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tagName: string) => {
      const element = createElement(tagName) as HTMLCanvasElement;
      if (tagName === 'canvas')
        Object.defineProperty(element, 'getContext', { value: () => ({ drawImage }) });
      return element;
    });
    const element = document.createElement('canvas');
    element.width = 400;
    element.height = 300;
    buildSafeRaster({
      canvas: canvasFixture(),
      sourceImage: {
        width: 120,
        height: 80,
        get: (key: string) => (key === 'cropX' ? 140 : key === 'cropY' ? 90 : undefined),
        getElement: () => element,
      } as never,
    });
    expect(drawImage).toHaveBeenCalledWith(element, 140, 90, 120, 80, 0, 0, 120, 80);
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
    expect(drawImage).toHaveBeenCalledWith(
      expect.any(HTMLCanvasElement),
      11,
      6,
      32,
      21,
      0,
      0,
      3,
      2,
    );
    expect(drawImage).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 0, 0, 3, 2, 0, 0, 32, 21);
  });
});
