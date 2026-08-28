import { describe, expect, it } from 'vitest';

import {
  centerEditorView,
  clampEditorPan,
  fitEditorScale,
  resizeEditorView,
  zoomEditorAtPoint,
} from './image-editor-viewport';

describe('image editor viewport geometry #3099', () => {
  const document = { width: 1200, height: 800 };
  const workspace = { width: 800, height: 600 };

  it('fits a large document inside the workspace inset and keeps small images at 100%', () => {
    expect(fitEditorScale(document, workspace)).toBeCloseTo(0.6267, 3);
    expect(fitEditorScale({ width: 100, height: 100 }, workspace)).toBe(1);
  });

  it('keeps the cursor point stable while zooming', () => {
    const view = zoomEditorAtPoint({
      view: { scale: 1, pan: { x: 0, y: 0 }, mode: 'actual' },
      document,
      workspace,
      point: { x: 500, y: 300 },
      scale: 2,
    });
    expect(view.pan).toEqual({ x: -100, y: 0 });
    expect(view.scale).toBe(2);
  });

  it('keeps 1:1 centered and preserves a custom view across resize', () => {
    expect(centerEditorView({ scale: 1, pan: { x: 200, y: -40 }, mode: 'actual' })).toEqual({
      scale: 1,
      pan: { x: 0, y: 0 },
      mode: 'actual',
    });
    expect(
      resizeEditorView({ scale: 2, pan: { x: 100, y: -50 }, mode: 'custom' }, document, {
        width: 600,
        height: 400,
      }),
    ).toMatchObject({ scale: 2, pan: { x: 100, y: -50 }, mode: 'custom' });
  });

  it('recomputes Fit mode after workspace resize', () => {
    expect(
      resizeEditorView({ scale: 1, pan: { x: 12, y: 9 }, mode: 'fit' }, document, {
        width: 600,
        height: 400,
      }),
    ).toEqual({ scale: 0.44, pan: { x: 0, y: 0 }, mode: 'fit' });
  });

  it('refits a restored large document when viewport mode remains fit', () => {
    const workspace = { width: 800, height: 600 };
    const cropped = { width: 400, height: 300 };
    const restored = { width: 1200, height: 800 };
    const croppedView = resizeEditorView(
      { scale: fitEditorScale(document, workspace), pan: { x: 0, y: 0 }, mode: 'fit' },
      cropped,
      workspace,
    );
    expect(croppedView).toEqual({ scale: 1, pan: { x: 0, y: 0 }, mode: 'fit' });
    expect(resizeEditorView(croppedView, restored, workspace)).toEqual({
      scale: fitEditorScale(restored, workspace),
      pan: { x: 0, y: 0 },
      mode: 'fit',
    });
  });

  it('clamps panning so a document cannot be permanently lost', () => {
    expect(clampEditorPan({ x: 10000, y: -10000 }, document, workspace, 1)).toEqual({
      x: 976,
      y: -676,
    });
  });
});
