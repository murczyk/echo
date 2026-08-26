import { describe, expect, it } from 'vitest';

import { imageEditorBounds, imageEditorPointer } from './image-editor-pointer';

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
});
