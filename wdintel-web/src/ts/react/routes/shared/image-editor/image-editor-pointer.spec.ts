import { describe, expect, it } from 'vitest';

import { imageEditorBounds, imageEditorPointer } from './image-editor-pointer';

// @test-scope regression: https://github.com/echoua/echo/issues/3099
describe('image editor native pointer geometry #3099', () => {
  it('converts CSS-scaled pointer coordinates into native document coordinates', () => {
    const canvas = {
      width: 1000,
      height: 600,
      upperCanvasEl: {
        getBoundingClientRect: () => ({ left: 20, top: 10, width: 500, height: 300 }),
      },
    } as never;
    expect(imageEditorPointer(canvas, { clientX: 270, clientY: 160 })).toEqual({ x: 500, y: 300 });
  });

  it('normalizes reverse and square drags from the same anchor', () => {
    expect(imageEditorBounds({ x: 500, y: 400 }, { x: 100, y: 200 })).toEqual({
      left: 100,
      top: 200,
      width: 400,
      height: 200,
    });
    expect(imageEditorBounds({ x: 500, y: 400 }, { x: 100, y: 200 }, true)).toEqual({
      left: 100,
      top: 0,
      width: 400,
      height: 400,
    });
  });

  it('keeps a constrained shape square while clamping it to image bounds', () => {
    const bounds = imageEditorBounds({ x: 950, y: 950 }, { x: 700, y: 600 }, true, {
      width: 1000,
      height: 1000,
    });
    expect(bounds.width).toBe(bounds.height);
    expect(bounds.left + bounds.width).toBeLessThanOrEqual(1000);
    expect(bounds.top + bounds.height).toBeLessThanOrEqual(1000);
  });

  it('uses the limiting edge as one shared size for asymmetric Shift drags', () => {
    expect(
      imageEditorBounds({ x: 900, y: 500 }, { x: 1000, y: 900 }, true, {
        width: 1000,
        height: 1000,
      }),
    ).toEqual({ left: 900, top: 500, width: 100, height: 100 });
  });
});
