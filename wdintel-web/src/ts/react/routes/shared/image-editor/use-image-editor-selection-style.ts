import { useEffect, type MutableRefObject } from 'react';

import type { ImageEditorTool } from './image-editor.types';

export function useImageEditorSelectionStyle({
  canvasRef,
  fabricRef,
  canvasReady,
  tool,
  stroke,
  fill,
  strokeWidth,
  dash,
  fontSize,
  bold,
  scheduleHistory,
}: {
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  fabricRef: MutableRefObject<typeof import('fabric') | null>;
  canvasReady: boolean;
  tool: ImageEditorTool;
  stroke: string;
  fill: string;
  strokeWidth: number;
  dash: boolean;
  fontSize: number;
  bold: boolean;
  scheduleHistory: () => void;
}) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.isDrawingMode = tool === 'brush' || tool === 'highlight';
    if (canvas.isDrawingMode && fabricRef.current) {
      const brush = new fabricRef.current.PencilBrush(canvas);
      brush.color = tool === 'highlight' ? `${stroke}88` : stroke;
      brush.width = strokeWidth;
      canvas.freeDrawingBrush = brush;
    }
    canvas.defaultCursor = tool === 'pan' ? 'grab' : 'default';
    canvas.selection = tool === 'select';
  }, [canvasReady, canvasRef, fabricRef, stroke, strokeWidth, tool]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const fabric = fabricRef.current;
    const selected = canvas?.getActiveObject();
    if (!canvas || !fabric || !(selected instanceof fabric.IText)) return;
    const fontWeight = bold ? 'bold' : 'normal';
    if (
      selected.fill === stroke &&
      selected.fontSize === fontSize &&
      selected.fontWeight === fontWeight
    )
      return;
    selected.set({ fill: stroke, fontSize, fontWeight });
    canvas.requestRenderAll();
    scheduleHistory();
  }, [bold, canvasReady, canvasRef, fabricRef, fontSize, scheduleHistory, stroke]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const fabric = fabricRef.current;
    const selected = canvas?.getActiveObject();
    if (
      !canvas ||
      !fabric ||
      !selected ||
      selected.get('editorRole') === 'source' ||
      selected instanceof fabric.IText
    )
      return;
    const properties = {
      stroke,
      fill: selected.get('editorRole') === 'concealment' ? selected.fill : fill,
      strokeWidth,
      strokeDashArray: dash ? [strokeWidth * 2, strokeWidth * 2] : undefined,
    };
    if (
      selected.stroke === properties.stroke &&
      selected.fill === properties.fill &&
      selected.strokeWidth === properties.strokeWidth &&
      JSON.stringify(selected.strokeDashArray ?? undefined) ===
        JSON.stringify(properties.strokeDashArray)
    )
      return;
    selected.set(properties);
    if (selected.get('editorRole') === 'arrow' && selected instanceof fabric.Group) {
      selected.getObjects().forEach((object) => {
        object.set({
          stroke,
          strokeWidth,
          strokeDashArray: dash ? [strokeWidth * 2, strokeWidth * 2] : undefined,
        });
        if (object instanceof fabric.Triangle) object.set({ fill: stroke });
      });
    }
    canvas.requestRenderAll();
    scheduleHistory();
  }, [canvasReady, canvasRef, dash, fabricRef, fill, scheduleHistory, stroke, strokeWidth]);
}
