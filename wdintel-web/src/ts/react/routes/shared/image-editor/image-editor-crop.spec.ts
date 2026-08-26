import { describe, expect, it } from 'vitest';

import { applyCrop, cancelCrop, normalizedCropFrame, startCrop } from './image-editor-crop';

describe('image editor crop bounds #3099', () => {
  it('normalizes scaled crop geometry and keeps every edge inside the document', () => {
    expect(
      normalizedCropFrame({
        left: 760,
        top: -20,
        width: 200,
        height: 150,
        scaleX: 2,
        scaleY: 3,
        canvasWidth: 1000,
        canvasHeight: 500,
      }),
    ).toEqual({ left: 600, top: 0, width: 400, height: 450, scaleX: 1, scaleY: 1 });
  });

  it('uses free crop scaling until Shift and restores canvas scaling on exit', () => {
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
      setControlsVisibility() {}
      setCoords() {}
      getBoundingRect() {
        return { left: 8, top: 8, width: 184, height: 84 };
      }
    }
    const objects: Rect[] = [];
    const canvas = {
      width: 200,
      height: 100,
      uniformScaling: true,
      uniScaleKey: 'altKey',
      upperCanvasEl: { getBoundingClientRect: () => ({ width: 200 }) },
      add: (object: Rect) => objects.push(object),
      remove: (object: Rect) => objects.splice(objects.indexOf(object), 1),
      getObjects: () => objects,
      setActiveObject() {},
      discardActiveObject() {},
      requestRenderAll() {},
      setDimensions() {},
    } as never;
    const cropRef = { current: null } as { current: import('fabric').Rect | null };
    const fabric = { Rect } as never;

    startCrop({ canvas, fabric, cropRef, stroke: '#fff', maskColor: '#000' });
    expect(canvas.uniformScaling).toBe(false);
    expect(canvas.uniScaleKey).toBe('shiftKey');

    cancelCrop({ canvas, cropRef });
    expect(canvas.uniformScaling).toBe(true);
    expect(canvas.uniScaleKey).toBe('altKey');

    const sourceImage = { get: () => 0, set() {} } as never;
    startCrop({ canvas, fabric, cropRef, stroke: '#fff', maskColor: '#000' });
    expect(applyCrop({ canvas, sourceImage, cropRef })).toBe(true);
    expect(canvas.uniformScaling).toBe(true);
    expect(canvas.uniScaleKey).toBe('altKey');
  });
});
