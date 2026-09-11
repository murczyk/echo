/**
 * @vitest-environment happy-dom
 */
import * as fabric from 'fabric';
import { describe, expect, it, vi } from 'vitest';

import { createArrow } from './image-editor-arrow';
import {
  cancelImageEditorAttachedArrowGesture,
  imageEditorAttachedArrowGeometry,
  installImageEditorAttachedArrowControl,
  IMAGE_EDITOR_ATTACHED_ARROW_ENDPOINT_CONTROL,
  setImageEditorAttachedArrowTarget,
} from './image-editor-attached-arrow';

HTMLCanvasElement.prototype.getContext = (() =>
  new Proxy(
    { measureText: () => ({ width: 10, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 2 }) },
    {
      get: (target, key) => (key in target ? target[key as keyof typeof target] : () => undefined),
    },
  )) as typeof HTMLCanvasElement.prototype.getContext;

function renderedEndpoints(arrow: import('fabric').Group) {
  const [shaft, head] = arrow.getObjects() as [import('fabric').Line, import('fabric').Triangle];
  const linePoints = (
    shaft as unknown as { calcLinePoints: () => { x1: number; y1: number } }
  ).calcLinePoints();
  const start = fabric.util.transformPoint(
    new fabric.Point(linePoints.x1, linePoints.y1),
    shaft.calcTransformMatrix(),
  );
  const end = fabric.util.transformPoint(
    new fabric.Point(head.left ?? 0, head.top ?? 0),
    arrow.calcTransformMatrix(),
  );
  return { start, end };
}

describe('image editor arrow geometry #3099', () => {
  it.each([
    [
      { x: 100, y: 100 },
      { x: 500, y: 500 },
    ],
    [
      { x: 500, y: 500 },
      { x: 100, y: 100 },
    ],
    [
      { x: 100, y: 500 },
      { x: 500, y: 100 },
    ],
    [
      { x: 500, y: 100 },
      { x: 100, y: 500 },
    ],
  ])('keeps rendered endpoints aligned with the gesture', (start, end) => {
    const arrow = createArrow({
      fabric,
      start,
      end,
      stroke: '#ef4444',
      strokeWidth: 4,
      dash: false,
    });
    expect(arrow).not.toBeNull();
    const rendered = renderedEndpoints(arrow!);
    expect(rendered.start.x).toBeCloseTo(start.x, 3);
    expect(rendered.start.y).toBeCloseTo(start.y, 3);
    expect(rendered.end.x).toBeCloseTo(end.x, 3);
    expect(rendered.end.y).toBeCloseTo(end.y, 3);
  });
});

describe('text callout geometry #3448', () => {
  it('anchors a rotated padded label at its transformed boundary', () => {
    const text = new fabric.IText('Текст', {
      left: 100,
      top: 100,
      originX: 'center',
      originY: 'center',
      angle: 35,
      scaleX: 1.5,
      scaleY: 0.75,
    });
    text.set({ annotationBackgroundEnabled: true, annotationBackgroundPadding: 6 });

    const geometry = imageEditorAttachedArrowGeometry(text, { x: 300, y: 250 });

    expect(geometry).not.toBeNull();
    expect(geometry!.end).toEqual({ x: 300, y: 250 });
    expect(geometry!.start).not.toEqual({ x: 100, y: 100 });
  });

  it('suppresses a degenerate shaft while retaining the target #3448', () => {
    const text = new fabric.IText('Текст', {
      left: 100,
      top: 100,
      originX: 'center',
      originY: 'center',
    });
    expect(imageEditorAttachedArrowGeometry(text, { x: 100, y: 100 })).toBeNull();
  });

  it('keeps an interior target as document state while suppressing its arrow #3448', () => {
    const text = new fabric.IText('Текст', {
      left: 100,
      top: 100,
      originX: 'center',
      originY: 'center',
    });
    setImageEditorAttachedArrowTarget(text, { x: 100, y: 100 });
    expect(text.get('attachedArrowTargetX')).toBe(100);
    expect(text.get('attachedArrowTargetY')).toBe(100);
    expect(imageEditorAttachedArrowGeometry(text, { x: 100, y: 100 })).toBeNull();
  });

  it('restores the previous endpoint when an adjustment is cancelled #3448', () => {
    const text = new fabric.IText('Текст', {
      left: 100,
      top: 100,
      originX: 'center',
      originY: 'center',
      editorRole: 'text',
    });
    setImageEditorAttachedArrowTarget(text, { x: 220, y: 100 });
    const objects: import('fabric').FabricObject[] = [text];
    const canvas = {
      getObjects: () => objects,
      add: (object: import('fabric').FabricObject) => objects.push(object),
      remove: (object: import('fabric').FabricObject) => {
        const index = objects.indexOf(object);
        if (index >= 0) objects.splice(index, 1);
      },
      moveObjectTo: () => undefined,
      requestRenderAll: () => undefined,
    } as never as import('fabric').Canvas;
    text.canvas = canvas;
    const complete = vi.fn();
    installImageEditorAttachedArrowControl({ canvas, fabric, text, onComplete: complete });
    const control = text.controls[IMAGE_EDITOR_ATTACHED_ARROW_ENDPOINT_CONTROL]!;
    const transform = { target: text } as never;
    control.mouseDownHandler?.(new MouseEvent('mousedown'), transform, 220, 100);
    control.actionHandler?.(new MouseEvent('mousemove'), transform, 260, 100);

    expect(text.get('attachedArrowTargetX')).toBe(260);
    expect(cancelImageEditorAttachedArrowGesture(canvas)).toBe(true);
    expect(text.get('attachedArrowTargetX')).toBe(220);
    expect(text.get('attachedArrowTargetY')).toBe(100);
    expect(complete).not.toHaveBeenCalled();
  });
});
