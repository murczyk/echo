import { describe, expect, it } from 'vitest';

import { applyImageEditorSurfaceCursor, imageEditorCursor } from '../image-editor-interaction-mode';

// @test-scope regression: https://github.com/echoua/echo/issues/3099
describe('imageEditorCursor', () => {
  it.each([
    ['select', 'default'],
    ['text', 'text'],
    ['rectangle', 'crosshair'],
    ['ellipse', 'crosshair'],
    ['line', 'crosshair'],
    ['arrow', 'crosshair'],
    ['conceal', 'crosshair'],
    ['brush', 'crosshair'],
    ['magnifier', 'zoom-in'],
    ['pan', 'grab'],
    ['crop', 'crosshair'],
  ] as const)('maps %s to %s', (tool, cursor) => {
    expect(imageEditorCursor(tool)).toBe(cursor);
  });

  it('applies transient cursors to Fabric upper canvas', () => {
    const upperCanvasEl = { style: {} } as HTMLCanvasElement;
    applyImageEditorSurfaceCursor({ upperCanvasEl } as never, 'grabbing');
    expect(upperCanvasEl.style.cursor).toBe('grabbing');
    applyImageEditorSurfaceCursor({ upperCanvasEl } as never, imageEditorCursor('crop'));
    expect(upperCanvasEl.style.cursor).toBe('crosshair');
    applyImageEditorSurfaceCursor({ upperCanvasEl } as never, 'wait');
    expect(upperCanvasEl.style.cursor).toBe('wait');
  });
});
