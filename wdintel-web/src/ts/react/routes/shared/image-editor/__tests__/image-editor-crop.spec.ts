import { describe, expect, it, vi } from 'vitest';

import { applyCrop, cancelCrop, normalizedCropFrame, startCrop } from '../image-editor-crop';

// @test-scope regression: https://github.com/echoua/echo/issues/3099
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
      controls = {
        tl: {},
        mt: {},
        tr: {},
        ml: {},
        mr: {},
        bl: {},
        mb: {},
        br: {},
      };
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
        return {
          left: Number(this.left ?? 0),
          top: Number(this.top ?? 0),
          width: Number(this.width ?? 0),
          height: Number(this.height ?? 0),
        };
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
    const fabric = {
      Rect,
      Control: class Control {
        constructor(options: Record<string, unknown>) {
          Object.assign(this, options);
        }
      },
    } as never;

    startCrop({ canvas, fabric, cropRef, stroke: '#fff', maskColor: '#000' });
    expect(cropRef.current).toMatchObject({ left: 0, top: 0, width: 200, height: 100 });
    expect(canvas.uniformScaling).toBe(false);
    expect(canvas.uniScaleKey).toBe('shiftKey');

    cancelCrop({ canvas, cropRef });
    expect(canvas.uniformScaling).toBe(true);
    expect(canvas.uniScaleKey).toBe('altKey');

    const sourceImage = { get: () => 0, set: vi.fn() } as never;
    startCrop({ canvas, fabric, cropRef, stroke: '#fff', maskColor: '#000' });
    expect(applyCrop({ canvas, sourceImage, cropRef })).toBe(true);
    expect(sourceImage.set).toHaveBeenCalledWith(
      expect.objectContaining({ cropX: 0, cropY: 0, width: 200, height: 100 }),
    );
    expect(canvas.uniformScaling).toBe(true);
    expect(canvas.uniScaleKey).toBe('altKey');
  });
});
