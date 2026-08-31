import { describe, expect, it } from 'vitest';

import { calculateMagnifierSample } from './image-editor-magnifier';

// @test-scope regression: https://github.com/echoua/echo/issues/3099
describe('image editor magnifier geometry #3099', () => {
  it('uses display scale, but never DPR, to calculate the native source rectangle', () => {
    expect(
      calculateMagnifierSample({
        canvasSize: { width: 1000, height: 1000 },
        displayedSize: { width: 1000, height: 1000 },
        pointer: { x: 500, y: 500 },
        lensDiameter: 144,
        magnification: 2,
      }),
    ).toEqual({ left: 464, top: 464, width: 72, height: 72 });
    expect(
      calculateMagnifierSample({
        canvasSize: { width: 1000, height: 1000 },
        displayedSize: { width: 500, height: 500 },
        pointer: { x: 250, y: 250 },
        lensDiameter: 144,
        magnification: 2,
      }),
    ).toEqual({ left: 428, top: 428, width: 144, height: 144 });
  });

  it('clamps native sampling at every image edge', () => {
    const common = {
      canvasSize: { width: 1000, height: 1000 },
      displayedSize: { width: 2000, height: 2000 },
      lensDiameter: 144,
      magnification: 2,
    };
    expect(calculateMagnifierSample({ ...common, pointer: { x: 0, y: 0 } })).toMatchObject({
      left: 0,
      top: 0,
    });
    expect(calculateMagnifierSample({ ...common, pointer: { x: 2000, y: 2000 } })).toMatchObject({
      left: 964,
      top: 964,
    });
  });
});
