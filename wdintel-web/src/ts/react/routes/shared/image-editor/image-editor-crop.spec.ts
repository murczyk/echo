import { describe, expect, it } from 'vitest';

import { normalizedCropFrame } from './image-editor-crop';

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
});
