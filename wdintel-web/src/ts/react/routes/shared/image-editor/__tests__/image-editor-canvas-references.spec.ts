import { describe, expect, it, vi } from 'vitest';

import { restoreImageEditorCanvasReferences } from '../image-editor-canvas-references';
import { IMAGE_EDITOR_TEXT_TYPE } from '../image-editor-padded-text';

// @test-scope regression: https://github.com/echoua/echo/issues/3099
describe('image editor document snapshot restoration', () => {
  it('restores dimensions and source geometry independently of Fabric JSON metadata', () => {
    const source = { set: vi.fn(), type: 'image' };
    const text = { type: 'i-text' };
    const restoredText = { type: IMAGE_EDITOR_TEXT_TYPE };
    const canvas = {
      backgroundImage: source,
      getObjects: () => [text, restoredText],
      setDimensions: vi.fn(),
      discardActiveObject: vi.fn(),
      requestRenderAll: vi.fn(),
    } as never;
    const sourceRef = { current: null } as never;
    const cropRef = { current: {} } as never;
    const container = {} as HTMLElement;
    const background = {
      cropX: 12,
      cropY: 34,
      width: 400,
      height: 300,
      left: 0,
      top: 0,
      originX: 'left' as const,
      originY: 'top' as const,
      scaleX: 1,
      scaleY: 1,
    };

    restoreImageEditorCanvasReferences({
      canvas,
      sourceRef,
      cropRef,
      hiddenTextareaContainer: container,
      snapshot: { serializedCanvas: '{}', width: 400, height: 300, background },
    });

    expect(source.set).toHaveBeenCalledWith(background);
    expect(canvas.setDimensions).toHaveBeenCalledWith({ width: 400, height: 300 });
    expect(sourceRef.current).toBe(source);
    expect(cropRef.current).toBeNull();
    expect(text.hiddenTextareaContainer).toBe(container);
    expect(restoredText.hiddenTextareaContainer).toBe(container);
  });
});
