import { useEffect, type MutableRefObject } from 'react';

import { addTextAnnotation } from './image-editor-actions';
import { createArrow } from './image-editor-arrow';
import type { ImageEditorTool } from './image-editor.types';

export function useImageEditorDrawingGestures({
  canvasRef,
  fabricRef,
  tool,
  toolRef,
  stroke,
  fill,
  strokeWidth,
  dash,
  fontSize,
  bold,
  isInteractionLocked,
  saveHistory,
  replaceConcealmentDraft,
  cancelGestureRef,
  setError,
}: {
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  fabricRef: MutableRefObject<typeof import('fabric') | null>;
  tool: ImageEditorTool;
  toolRef: MutableRefObject<ImageEditorTool>;
  stroke: string;
  fill: string;
  strokeWidth: number;
  dash: boolean;
  fontSize: number;
  bold: boolean;
  isInteractionLocked: () => boolean;
  saveHistory: () => void;
  replaceConcealmentDraft: (draft: import('fabric').FabricObject) => Promise<void>;
  cancelGestureRef: MutableRefObject<() => void>;
  setError: (error: string) => void;
}) {
  useEffect(() => {
    const canvas = canvasRef.current;
    const fabric = fabricRef.current;
    if (!canvas || !fabric) return;
    let start: { x: number; y: number } | null = null;
    let drawing: import('fabric').FabricObject | null = null;
    const clearGesture = () => {
      if (drawing) canvas.remove(drawing);
      start = null;
      drawing = null;
      canvas.requestRenderAll();
    };
    cancelGestureRef.current = clearGesture;
    const begin = (event: { scenePoint: { x: number; y: number }; e?: unknown }) => {
      if (isInteractionLocked() || toolRef.current !== tool) return;
      const point = event.scenePoint;
      if (tool === 'text') {
        addTextAnnotation({ canvas, fabric, stroke, fontSize, bold, left: point.x, top: point.y });
        saveHistory();
        return;
      }
      if (!['rectangle', 'ellipse', 'line', 'arrow', 'conceal'].includes(tool)) return;
      start = point;
      const common = {
        left: point.x,
        top: point.y,
        stroke,
        strokeWidth,
        fill,
        editorRole: tool === 'conceal' ? 'concealment-draft' : tool,
        strokeDashArray: dash ? [strokeWidth * 2, strokeWidth * 2] : undefined,
        selectable: false,
        evented: false,
      };
      drawing =
        tool === 'ellipse'
          ? new fabric.Ellipse({ ...common, rx: 1, ry: 1 })
          : tool === 'line' || tool === 'arrow'
            ? new fabric.Line([point.x, point.y, point.x, point.y], { ...common, fill: undefined })
            : new fabric.Rect({
                ...common,
                width: 1,
                height: 1,
                fill: tool === 'conceal' ? 'rgba(100,116,139,0.35)' : fill,
              });
      canvas.add(drawing);
    };
    const move = (event: { scenePoint: { x: number; y: number }; e?: unknown }) => {
      if (isInteractionLocked()) return clearGesture();
      if (!start || !drawing) return;
      const point = event.scenePoint;
      const x = Math.min(start.x, point.x);
      const y = Math.min(start.y, point.y);
      const rawWidth = Math.abs(point.x - start.x);
      const rawHeight = Math.abs(point.y - start.y);
      const size = Math.max(rawWidth, rawHeight);
      const shiftKey = (event.e as { shiftKey?: boolean } | undefined)?.shiftKey;
      const width = shiftKey ? size : rawWidth;
      const height = shiftKey ? size : rawHeight;
      if (drawing instanceof fabric.Line) drawing.set({ x2: point.x, y2: point.y });
      else if (drawing instanceof fabric.Ellipse)
        drawing.set({ left: x, top: y, rx: width / 2, ry: height / 2 });
      else drawing.set({ left: x, top: y, width, height });
      canvas.requestRenderAll();
    };
    const end = () => {
      if (isInteractionLocked()) return clearGesture();
      if (drawing instanceof fabric.Line && tool === 'arrow' && start) {
        const arrow = createArrow({
          fabric,
          start: { x: drawing.x1 ?? start.x, y: drawing.y1 ?? start.y },
          end: { x: drawing.x2 ?? start.x, y: drawing.y2 ?? start.y },
          stroke,
          strokeWidth,
          dash,
        });
        canvas.remove(drawing);
        if (arrow) {
          canvas.add(arrow);
          saveHistory();
        }
      } else if (drawing && tool === 'conceal') {
        replaceConcealmentDraft(drawing).catch((cause) =>
          setError(cause instanceof Error ? cause.message : 'Не вдалося застосувати розмиття'),
        );
      } else if (drawing && Math.max(drawing.width ?? 0, drawing.height ?? 0) >= 3) {
        saveHistory();
      } else if (drawing) {
        canvas.remove(drawing);
      }
      start = null;
      drawing = null;
    };
    canvas.on('mouse:down', begin);
    canvas.on('mouse:move', move);
    canvas.on('mouse:up', end);
    return () => {
      clearGesture();
      cancelGestureRef.current = () => {};
      canvas.off('mouse:down', begin);
      canvas.off('mouse:move', move);
      canvas.off('mouse:up', end);
    };
  }, [
    bold,
    cancelGestureRef,
    canvasRef,
    dash,
    fabricRef,
    fill,
    fontSize,
    isInteractionLocked,
    replaceConcealmentDraft,
    saveHistory,
    setError,
    stroke,
    strokeWidth,
    tool,
    toolRef,
  ]);
}
