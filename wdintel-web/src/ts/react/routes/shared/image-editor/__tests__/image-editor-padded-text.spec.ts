/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';

import {
  createPaddedTextAnnotation,
  registerPaddedTextAnnotation,
  TEXT_BACKGROUND_PADDING_MAX,
  TEXT_BACKGROUND_PADDING_MIN,
} from '../image-editor-padded-text';

const context = new Proxy(
  { measureText: () => ({ width: 10, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 2 }) },
  { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined) },
);
HTMLCanvasElement.prototype.getContext = (() =>
  context) as typeof HTMLCanvasElement.prototype.getContext;

// Regression: https://github.com/echoua/echo/issues/3294
describe('padded text annotation lifecycle #3294', () => {
  it('serializes and revives editable text background settings', async () => {
    const fabric = await import('fabric');
    registerPaddedTextAnnotation(fabric);
    const text = createPaddedTextAnnotation({
      fabric,
      text: 'Текст',
      options: {
        editorRole: 'text',
        annotationBackgroundEnabled: true,
        annotationBackgroundColor: '#112233',
        annotationBackgroundPadding: 6,
      },
    });
    const serialized = text.toObject();
    const Text = fabric.classRegistry.getClass('image-editor-text') as typeof fabric.IText;
    const revived = await Text.fromObject(serialized as never);

    expect(revived).toBeInstanceOf(fabric.IText);
    expect(revived.text).toBe('Текст');
    expect(revived.get('editorRole')).toBe('text');
    expect(revived.get('annotationBackgroundEnabled')).toBe(true);
    expect(revived.get('annotationBackgroundColor')).toBe('#112233');
    expect(revived.get('annotationBackgroundPadding')).toBe(6);
    expect(revived.get('textBackgroundColor')).toBe('');
    for (const [property, value] of [
      ['annotationBackgroundEnabled', false],
      ['annotationBackgroundColor', '#445566'],
      ['annotationBackgroundPadding', 7],
    ]) {
      text.dirty = false;
      text.set({ [property]: value });
      expect(text.dirty).toBe(true);
    }
  });

  it('renders one padded rectangle only while enabled #3294', async () => {
    const fabric = await import('fabric');
    registerPaddedTextAnnotation(fabric);
    const text = createPaddedTextAnnotation({
      fabric,
      text: 'A',
      options: { annotationBackgroundColor: '#112233', annotationBackgroundPadding: 6 },
    }) as never as {
      renderAnnotationBackground: (context: CanvasRenderingContext2D) => void;
      _getCacheCanvasDimensions: () => {
        width: number;
        height: number;
        zoomX: number;
        zoomY: number;
      };
      set: (value: unknown) => void;
      dirty: boolean;
      width: number;
      height: number;
    };
    const fillRect = vi.fn();
    const draw = { save: vi.fn(), restore: vi.fn(), fillRect } as never as CanvasRenderingContext2D;
    text.width = 10;
    text.height = 20;
    const unpadded = text._getCacheCanvasDimensions();
    text.renderAnnotationBackground(draw);
    expect(fillRect).not.toHaveBeenCalled();
    text.set({ annotationBackgroundEnabled: true });
    text.renderAnnotationBackground(draw);
    expect(fillRect).toHaveBeenCalledOnce();
    expect(draw.fillStyle).toBe('#112233');
    expect(fillRect).toHaveBeenCalledWith(-11, -16, 22, 32);
    const padded = text._getCacheCanvasDimensions();
    expect(padded.width).toBe(unpadded.width + 12 * padded.zoomX);
    expect(padded.height).toBe(unpadded.height + 12 * padded.zoomY);

    fillRect.mockClear();
    text.set({ annotationBackgroundPadding: TEXT_BACKGROUND_PADDING_MIN - 1 });
    text.renderAnnotationBackground(draw);
    expect(fillRect).toHaveBeenCalledWith(-5, -10, 10, 20);
    fillRect.mockClear();
    text.set({ annotationBackgroundPadding: TEXT_BACKGROUND_PADDING_MAX + 1 });
    text.renderAnnotationBackground(draw);
    expect(fillRect).toHaveBeenCalledWith(-37, -42, 74, 84);
    const clamped = text._getCacheCanvasDimensions();
    expect(clamped.width).toBe(unpadded.width + TEXT_BACKGROUND_PADDING_MAX * 2 * clamped.zoomX);
    expect(clamped.height).toBe(unpadded.height + TEXT_BACKGROUND_PADDING_MAX * 2 * clamped.zoomY);
  });
});
