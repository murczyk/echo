/**
 * @vitest-environment happy-dom
 */
import * as fabric from 'fabric';
import { describe, expect, it, vi } from 'vitest';

import { createArrow } from './image-editor-arrow';
import { applyArrowStyle, readImageEditorObjectStyle } from './image-editor-selection-style';
import {
  cancelImageEditorAttachedArrowGesture,
  imageEditorAttachedArrowGeometry,
  installImageEditorAttachedArrowControl,
  IMAGE_EDITOR_ATTACHED_ARROW_CONTROL,
  IMAGE_EDITOR_ATTACHED_ARROW_ENDPOINT_CONTROL,
  removeImageEditorAttachedArrow,
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

function touchEvent(type: string, changed: { x: number; y: number } | null) {
  const event = new TouchEvent(type);
  const contact = changed ? [{ clientX: changed.x, clientY: changed.y }] : [];
  Object.defineProperties(event, {
    changedTouches: { value: contact },
    touches: { value: type === 'touchend' ? [] : contact },
  });
  return event;
}

function attachedArrowHarness(target?: { x: number; y: number }) {
  const text = new fabric.IText('Текст', {
    left: 100,
    top: 100,
    originX: 'center',
    originY: 'center',
    editorRole: 'text',
  });
  if (target) setImageEditorAttachedArrowTarget(text, target);
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
    fire: () => undefined,
  } as never as import('fabric').Canvas;
  text.canvas = canvas;
  const complete = vi.fn();
  installImageEditorAttachedArrowControl({ canvas, fabric, text, onComplete: complete });
  return {
    complete,
    create: text.controls[IMAGE_EDITOR_ATTACHED_ARROW_CONTROL]!,
    endpoint: text.controls[IMAGE_EDITOR_ATTACHED_ARROW_ENDPOINT_CONTROL]!,
    text,
    transform: { target: text } as never,
  };
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

describe('standalone arrow style preservation #3448', () => {
  it('merges color, width, and dash against the rendered shaft rather than Group defaults', () => {
    const arrow = createArrow({
      fabric,
      start: { x: 10, y: 10 },
      end: { x: 110, y: 10 },
      stroke: '#ef4444',
      strokeWidth: 4,
      dash: false,
    })!;
    expect(readImageEditorObjectStyle(arrow, fabric)).toMatchObject({
      stroke: '#ef4444',
      strokeWidth: 4,
      dash: false,
    });
    expect(
      applyArrowStyle({ selected: arrow, fabric, stroke: '#22c55e', strokeWidth: 4, dash: false }),
    ).toBe(true);
    expect(readImageEditorObjectStyle(arrow, fabric)).toMatchObject({
      stroke: '#22c55e',
      strokeWidth: 4,
      dash: false,
    });
    expect(
      applyArrowStyle({ selected: arrow, fabric, stroke: '#22c55e', strokeWidth: 8, dash: true }),
    ).toBe(true);
    expect(readImageEditorObjectStyle(arrow, fabric)).toMatchObject({
      stroke: '#22c55e',
      strokeWidth: 8,
      dash: true,
    });
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

  it('refreshes Fabric control coordinates as a target is committed or removed #3448', () => {
    const text = new fabric.IText('Текст', { left: 100, top: 100 });
    const setCoords = vi.spyOn(text, 'setCoords');
    setImageEditorAttachedArrowTarget(text, { x: 220, y: 100 });
    expect(setCoords).toHaveBeenCalledOnce();
    removeImageEditorAttachedArrow({ getObjects: () => [], remove: vi.fn() } as never, text);
    expect(setCoords).toHaveBeenCalledTimes(2);
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

    expect(text.get('attachedArrowTargetX')).toBe(220);
    expect(cancelImageEditorAttachedArrowGesture(canvas)).toBe(true);
    expect(text.get('attachedArrowTargetX')).toBe(220);
    expect(text.get('attachedArrowTargetY')).toBe(100);
    expect(complete).not.toHaveBeenCalled();
  });

  it('updates endpoint-control coordinates immediately after creation #3448', () => {
    const text = new fabric.IText('Текст', {
      left: 100,
      top: 100,
      originX: 'center',
      originY: 'center',
      editorRole: 'text',
    });
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
      fire: () => undefined,
    } as never as import('fabric').Canvas;
    text.canvas = canvas;
    const setCoords = vi.spyOn(text, 'setCoords');
    installImageEditorAttachedArrowControl({ canvas, fabric, text, onComplete: vi.fn() });
    const control = text.controls[IMAGE_EDITOR_ATTACHED_ARROW_CONTROL]!;
    const transform = { target: text } as never;
    control.mouseDownHandler?.(
      new MouseEvent('mousedown', { clientX: 100, clientY: 100 }),
      transform,
      100,
      100,
    );
    control.actionHandler?.(
      new MouseEvent('mousemove', { clientX: 260, clientY: 100 }),
      transform,
      260,
      100,
    );
    control.mouseUpHandler?.(
      new MouseEvent('mouseup', { clientX: 260, clientY: 100 }),
      transform,
      260,
      100,
    );
    expect(text.get('attachedArrowTargetX')).toBe(260);
    expect(setCoords).toHaveBeenCalled();
  });

  it('ignores stale control callbacks after cancellation #3448', () => {
    const text = new fabric.IText('Текст', {
      left: 100,
      top: 100,
      originX: 'center',
      originY: 'center',
      editorRole: 'text',
    });
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
      fire: () => undefined,
    } as never as import('fabric').Canvas;
    text.canvas = canvas;
    const complete = vi.fn();
    installImageEditorAttachedArrowControl({ canvas, fabric, text, onComplete: complete });
    const control = text.controls[IMAGE_EDITOR_ATTACHED_ARROW_CONTROL]!;
    const transform = { target: text } as never;
    control.mouseDownHandler?.(
      new MouseEvent('mousedown', { clientX: 100, clientY: 100 }),
      transform,
      100,
      100,
    );
    control.actionHandler?.(
      new MouseEvent('mousemove', { clientX: 260, clientY: 100 }),
      transform,
      260,
      100,
    );
    expect(cancelImageEditorAttachedArrowGesture(canvas)).toBe(true);
    control.actionHandler?.(
      new MouseEvent('mousemove', { clientX: 280, clientY: 100 }),
      transform,
      280,
      100,
    );
    control.mouseUpHandler?.(
      new MouseEvent('mouseup', { clientX: 280, clientY: 100 }),
      transform,
      280,
      100,
    );
    expect(text.get('attachedArrowTargetX')).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('uses the final invalid release point and restores the previous endpoint #3448', () => {
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
      fire: () => undefined,
    } as never as import('fabric').Canvas;
    text.canvas = canvas;
    const complete = vi.fn();
    installImageEditorAttachedArrowControl({ canvas, fabric, text, onComplete: complete });
    const control = text.controls[IMAGE_EDITOR_ATTACHED_ARROW_ENDPOINT_CONTROL]!;
    const transform = { target: text } as never;
    control.mouseDownHandler?.(
      new MouseEvent('mousedown', { clientX: 220, clientY: 100 }),
      transform,
      220,
      100,
    );
    control.actionHandler?.(
      new MouseEvent('mousemove', { clientX: 260, clientY: 100 }),
      transform,
      260,
      100,
    );
    control.mouseUpHandler?.(
      new MouseEvent('mouseup', { clientX: 100, clientY: 100 }),
      transform,
      100,
      100,
    );
    expect(text.get('attachedArrowTargetX')).toBe(220);
    expect(complete).not.toHaveBeenCalled();
  });

  it('creates an attached arrow from a touch gesture #3448', () => {
    const harness = attachedArrowHarness();
    harness.create.mouseDownHandler?.(
      touchEvent('touchstart', { x: 100, y: 100 }),
      harness.transform,
      100,
      100,
    );
    harness.create.actionHandler?.(
      touchEvent('touchmove', { x: 260, y: 100 }),
      harness.transform,
      260,
      100,
    );
    harness.create.mouseUpHandler?.(
      touchEvent('touchend', { x: 260, y: 100 }),
      harness.transform,
      260,
      100,
    );
    expect(harness.text.get('attachedArrowTargetX')).toBe(260);
    expect(harness.text.get('attachedArrowTargetY')).toBe(100);
    expect(harness.complete).toHaveBeenCalledOnce();
  });

  it('repositions an attached endpoint from a touch gesture #3448', () => {
    const harness = attachedArrowHarness({ x: 220, y: 100 });
    harness.endpoint.mouseDownHandler?.(
      touchEvent('touchstart', { x: 220, y: 100 }),
      harness.transform,
      220,
      100,
    );
    harness.endpoint.actionHandler?.(
      touchEvent('touchmove', { x: 260, y: 100 }),
      harness.transform,
      260,
      100,
    );
    harness.endpoint.mouseUpHandler?.(
      touchEvent('touchend', { x: 260, y: 100 }),
      harness.transform,
      260,
      100,
    );
    expect(harness.text.get('attachedArrowTargetX')).toBe(260);
    expect(harness.complete).toHaveBeenCalledOnce();
  });

  it('rejects a touch tap without movement #3448', () => {
    const harness = attachedArrowHarness();
    harness.create.mouseDownHandler?.(
      touchEvent('touchstart', { x: 100, y: 100 }),
      harness.transform,
      100,
      100,
    );
    harness.create.mouseUpHandler?.(
      touchEvent('touchend', { x: 100, y: 100 }),
      harness.transform,
      100,
      100,
    );
    expect(harness.text.get('attachedArrowTargetX')).toBeUndefined();
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it('uses an invalid final touch release rather than the previous move #3448', () => {
    const harness = attachedArrowHarness({ x: 220, y: 100 });
    harness.endpoint.mouseDownHandler?.(
      touchEvent('touchstart', { x: 220, y: 100 }),
      harness.transform,
      220,
      100,
    );
    harness.endpoint.actionHandler?.(
      touchEvent('touchmove', { x: 260, y: 100 }),
      harness.transform,
      260,
      100,
    );
    harness.endpoint.mouseUpHandler?.(
      touchEvent('touchend', { x: 100, y: 100 }),
      harness.transform,
      100,
      100,
    );
    expect(harness.text.get('attachedArrowTargetX')).toBe(220);
    expect(harness.complete).not.toHaveBeenCalled();
  });
});
