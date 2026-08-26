import { describe, expect, it, vi } from 'vitest';

import { finalizeImageEditorText } from './use-image-editor-canvas';

describe('image editor text exit #3099', () => {
  it('removes empty text without saving and saves non-empty text once', () => {
    const canvas = { remove: vi.fn(), requestRenderAll: vi.fn() } as never;
    const saveHistory = vi.fn();
    expect(finalizeImageEditorText(canvas, { text: '' } as never, saveHistory)).toBe(false);
    expect(canvas.remove).toHaveBeenCalledOnce();
    expect(saveHistory).not.toHaveBeenCalled();
    expect(finalizeImageEditorText(canvas, { text: 'Текст' } as never, saveHistory)).toBe(true);
    expect(saveHistory).toHaveBeenCalledOnce();
  });
});
