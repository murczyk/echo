import { useEffect, useRef, type MutableRefObject } from 'react';

import { addTextAnnotation } from './image-editor-actions';
import { createArrow } from './image-editor-arrow';
import { imageEditorBounds, imageEditorPointer, minimumGestureSize } from './image-editor-pointer';
import type { ImageEditorBounds } from './image-editor-pointer';
import type { ConcealMode, ImageEditorTool } from './image-editor.types';

type Point = { x: number; y: number };
type Config = {
  tool: ImageEditorTool;
  stroke: string;
  fill: string;
  strokeWidth: number;
  dash: boolean;
  fontSize: number;
  bold: boolean;
  textBackgroundColor: string;
  textBackgroundEnabled: boolean;
  textBackgroundPadding: number;
  concealMode: ConcealMode;
  concealmentMarquee: { stroke: string; fill: string };
};
type Session =
  | { kind: 'idle' }
  | { kind: 'text'; point: Point; config: Config }
  | {
      kind: 'shape';
      tool: 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'conceal';
      start: Point;
      object: import('fabric').FabricObject;
      config: Config;
    };

function finalizeGestureSession(session: Session) {
  return { completed: session, next: { kind: 'idle' } as Session };
}

function cancelGestureSession(session: Session) {
  return {
    next: { kind: 'idle' } as Session,
    transient: session.kind === 'shape' ? session.object : null,
  };
}

export function useImageEditorDrawingGestures({
  canvasRef,
  fabricRef,
  canvasReady,
  tool,
  toolRef,
  stroke,
  fill,
  strokeWidth,
  dash,
  fontSize,
  bold,
  textBackgroundColor,
  textBackgroundEnabled,
  textBackgroundPadding,
  concealMode,
  isInteractionLocked,
  saveHistory,
  replaceConcealmentArea,
  concealmentMarquee,
  cancelGestureRef,
  setError,
  hiddenTextareaContainer,
}: {
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  fabricRef: MutableRefObject<typeof import('fabric') | null>;
  canvasReady: boolean;
  tool: ImageEditorTool;
  toolRef: MutableRefObject<ImageEditorTool>;
  stroke: string;
  fill: string;
  strokeWidth: number;
  dash: boolean;
  fontSize: number;
  bold: boolean;
  textBackgroundColor: string;
  textBackgroundEnabled: boolean;
  textBackgroundPadding: number;
  concealMode: ConcealMode;
  isInteractionLocked: () => boolean;
  saveHistory: () => void;
  replaceConcealmentArea: (bounds: ImageEditorBounds, mode: ConcealMode) => Promise<void>;
  concealmentMarquee: { stroke: string; fill: string };
  cancelGestureRef: MutableRefObject<() => boolean>;
  setError: (error: string) => void;
  hiddenTextareaContainer: MutableRefObject<HTMLElement | null>;
}) {
  const configRef = useRef<Config>({
    tool,
    stroke,
    fill,
    strokeWidth,
    dash,
    fontSize,
    bold,
    textBackgroundColor,
    textBackgroundEnabled,
    textBackgroundPadding,
    concealMode,
    concealmentMarquee,
  });
  const operationsRef = useRef({
    isInteractionLocked,
    saveHistory,
    replaceConcealmentArea,
    setError,
  });
  configRef.current = {
    tool,
    stroke,
    fill,
    strokeWidth,
    dash,
    fontSize,
    bold,
    textBackgroundColor,
    textBackgroundEnabled,
    textBackgroundPadding,
    concealMode,
    concealmentMarquee,
  };
  operationsRef.current = { isInteractionLocked, saveHistory, replaceConcealmentArea, setError };

  useEffect(() => {
    const canvas = canvasRef.current;
    const fabric = fabricRef.current;
    if (!canvasReady || !canvas || !fabric) return;
    let session: Session = { kind: 'idle' };
    let textFrame: number | null = null;
    let finalBounds: ImageEditorBounds | null = null;
    const reset = () => {
      const consumed = session.kind !== 'idle' || textFrame != null;
      const cancelled = cancelGestureSession(session);
      if (cancelled.transient) canvas.remove(cancelled.transient);
      session = cancelled.next;
      finalBounds = null;
      if (textFrame != null) cancelAnimationFrame(textFrame);
      textFrame = null;
      canvas.requestRenderAll();
      return consumed;
    };
    cancelGestureRef.current = reset;
    const pointer = (event: { e?: unknown }) => {
      const source = event.e as { clientX?: number; clientY?: number } | undefined;
      return source?.clientX == null || source.clientY == null
        ? null
        : imageEditorPointer(canvas, source as { clientX: number; clientY: number });
    };
    const down = (event: { e?: unknown }) => {
      const config = configRef.current;
      if (session.kind !== 'idle' || operationsRef.current.isInteractionLocked()) return;
      const point = pointer(event);
      if (!point) return;
      if (config.tool === 'text') {
        session = { kind: 'text', point, config };
        return;
      }
      if (!['rectangle', 'ellipse', 'line', 'arrow', 'conceal'].includes(config.tool)) return;
      const tool = config.tool as 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'conceal';
      const common = {
        originX: 'left' as const,
        originY: 'top' as const,
        selectable: false,
        evented: false,
        editorRole: tool === 'conceal' ? 'concealment-draft' : tool,
      };
      const object =
        tool === 'ellipse'
          ? new fabric.Ellipse({
              ...common,
              left: point.x,
              top: point.y,
              rx: 1,
              ry: 1,
              stroke: config.stroke,
              strokeWidth: config.strokeWidth,
              strokeDashArray: config.dash
                ? [config.strokeWidth * 2, config.strokeWidth * 2]
                : undefined,
              fill: config.fill,
            })
          : tool === 'line' || tool === 'arrow'
            ? new fabric.Line([point.x, point.y, point.x, point.y], {
                stroke: config.stroke,
                strokeWidth: config.strokeWidth,
                strokeDashArray: config.dash
                  ? [config.strokeWidth * 2, config.strokeWidth * 2]
                  : undefined,
                selectable: false,
                evented: false,
                editorRole: tool,
              })
            : new fabric.Rect({
                ...common,
                left: point.x,
                top: point.y,
                width: 1,
                height: 1,
                stroke: tool === 'conceal' ? config.concealmentMarquee.stroke : config.stroke,
                strokeWidth: tool === 'conceal' ? 1 : config.strokeWidth,
                strokeDashArray:
                  tool === 'conceal'
                    ? undefined
                    : config.dash
                      ? [config.strokeWidth * 2, config.strokeWidth * 2]
                      : undefined,
                fill: tool === 'conceal' ? config.concealmentMarquee.fill : config.fill,
                excludeFromExport: tool === 'conceal',
              });
      canvas.add(object);
      finalBounds = null;
      session = { kind: 'shape', tool, start: point, object, config };
    };
    const move = (event: { e?: unknown }) => {
      if (operationsRef.current.isInteractionLocked()) return reset();
      if (session.kind !== 'shape') return;
      const point = pointer(event);
      if (!point) return;
      const square = Boolean((event.e as { shiftKey?: boolean })?.shiftKey);
      const bounds = imageEditorBounds(session.start, point, square, canvas);
      finalBounds = bounds;
      if (session.object instanceof fabric.Line) session.object.set({ x2: point.x, y2: point.y });
      else if (session.object instanceof fabric.Ellipse)
        session.object.set({
          left: bounds.left,
          top: bounds.top,
          rx: bounds.width / 2,
          ry: bounds.height / 2,
        });
      else session.object.set(bounds);
      session.object.setCoords();
      canvas.requestRenderAll();
    };
    const up = (event: { e?: unknown }) => {
      const finalized = finalizeGestureSession(session);
      const completed = finalized.completed;
      session = finalized.next;
      if (completed.kind === 'idle') return;
      if (operationsRef.current.isInteractionLocked()) {
        if (completed.kind === 'shape') canvas.remove(completed.object);
        return;
      }
      if (completed.kind === 'text') {
        const text = addTextAnnotation({
          canvas,
          fabric,
          stroke: completed.config.stroke,
          fontSize: completed.config.fontSize,
          bold: completed.config.bold,
          backgroundColor: completed.config.textBackgroundColor,
          backgroundEnabled: completed.config.textBackgroundEnabled,
          backgroundPadding: completed.config.textBackgroundPadding,
          left: completed.point.x,
          top: completed.point.y,
          hiddenTextareaContainer: hiddenTextareaContainer.current,
        });
        textFrame = requestAnimationFrame(() => {
          textFrame = null;
          if (operationsRef.current.isInteractionLocked()) return canvas.remove(text);
          canvas.setActiveObject(text);
          text.enterEditing();
          const textarea = text.hiddenTextarea;
          const container = hiddenTextareaContainer.current;
          if (!textarea?.isConnected || !container?.contains(textarea)) {
            operationsRef.current.setError('Не вдалося активувати текстове поле');
            return;
          }
          textarea.focus();
          if (document.activeElement !== textarea) {
            operationsRef.current.setError('Не вдалося сфокусувати текстове поле');
            return;
          }
          text.selectAll();
          canvas.requestRenderAll();
        });
        return;
      }
      const point = pointer(event);
      const bounds = finalBounds;
      finalBounds = null;
      const threshold = minimumGestureSize(canvas);
      try {
        if (completed.tool === 'conceal') {
          canvas.remove(completed.object);
          if (bounds && bounds.width >= threshold && bounds.height >= threshold)
            void operationsRef.current
              .replaceConcealmentArea(bounds, completed.config.concealMode)
              .catch((cause) =>
                operationsRef.current.setError(
                  cause instanceof Error ? cause.message : 'Не вдалося застосувати розмиття',
                ),
              );
        } else if (completed.tool === 'arrow' && point) {
          const arrow = createArrow({
            fabric,
            start: completed.start,
            end: point,
            stroke: completed.config.stroke,
            strokeWidth: completed.config.strokeWidth,
            dash: completed.config.dash,
          });
          canvas.remove(completed.object);
          if (arrow) {
            canvas.add(arrow);
            operationsRef.current.saveHistory();
          }
        } else if (
          completed.object instanceof fabric.Line
            ? point &&
              Math.hypot(point.x - completed.start.x, point.y - completed.start.y) >= threshold
            : bounds && bounds.width >= threshold && bounds.height >= threshold
        ) {
          completed.object.setCoords();
          operationsRef.current.saveHistory();
        } else canvas.remove(completed.object);
      } finally {
        canvas.requestRenderAll();
      }
    };
    canvas.on('mouse:down', down);
    canvas.on('mouse:move', move);
    canvas.on('mouse:up', up);
    return () => {
      reset();
      cancelGestureRef.current = () => false;
      canvas.off('mouse:down', down);
      canvas.off('mouse:move', move);
      canvas.off('mouse:up', up);
    };
  }, [canvasReady, canvasRef, fabricRef, cancelGestureRef, hiddenTextareaContainer]);
}
