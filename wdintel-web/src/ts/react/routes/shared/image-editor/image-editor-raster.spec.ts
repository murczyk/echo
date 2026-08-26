/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { replaceConcealmentDraft } from './image-editor-raster';

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

const fabric = {
  FabricImage: { fromURL: vi.fn().mockResolvedValue(new FabricObject()) },
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
    const draft = {
      getBoundingRect: () => ({ left: 20, top: 10, width: 30, height: 20 }),
    } as never;

    await replaceConcealmentDraft({
      canvas,
      sourceImage: sourceImage(),
      fabric: fabric as never,
      draft,
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
});
