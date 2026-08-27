import { useEffect, type MutableRefObject } from 'react';

import {
  applyArrowStyle,
  editorObjectRole,
  normalizeEditorColor,
  withHighlightAlpha,
} from './image-editor-selection-style';
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
  textBackgroundColor,
  textBackgroundEnabled,
  textBackgroundPadding,
  highlightOpacity,
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
  textBackgroundColor: string;
  textBackgroundEnabled: boolean;
  textBackgroundPadding: number;
  highlightOpacity: number;
  scheduleHistory: () => void;
}) {
  useEffect(() => {
    const canvas = canvasRef.current;
    const fabric = fabricRef.current;
    const selected = canvas?.getActiveObject();
    if (!canvas || !fabric || !(selected instanceof fabric.IText)) return;
    const text = selected as typeof selected & {
      annotationBackgroundColor?: string;
      annotationBackgroundEnabled?: boolean;
      annotationBackgroundPadding?: number;
    };
    const fontWeight = bold ? 'bold' : 'normal';
    if (
      selected.fill === stroke &&
      selected.fontSize === fontSize &&
      selected.fontWeight === fontWeight &&
      text.annotationBackgroundColor === textBackgroundColor &&
      text.annotationBackgroundEnabled === textBackgroundEnabled &&
      text.annotationBackgroundPadding === textBackgroundPadding
    )
      return;
    selected.set({
      fill: stroke,
      fontSize,
      fontWeight,
      annotationBackgroundColor: textBackgroundColor,
      annotationBackgroundEnabled: textBackgroundEnabled,
      annotationBackgroundPadding: textBackgroundPadding,
    } as never);
    canvas.requestRenderAll();
    scheduleHistory();
  }, [
    bold,
    canvasReady,
    canvasRef,
    fabricRef,
    fontSize,
    scheduleHistory,
    stroke,
    textBackgroundColor,
    textBackgroundEnabled,
    textBackgroundPadding,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const fabric = fabricRef.current;
    const selected = canvas?.getActiveObject();
    if (!canvas || !fabric || !selected || selected instanceof fabric.IText) return;
    const role = editorObjectRole(selected, fabric);
    if (!role || !['rectangle', 'ellipse', 'line', 'arrow', 'brush', 'highlight'].includes(role))
      return;
    const isShape = role === 'rectangle' || role === 'ellipse';
    const supportsDash = isShape || role === 'line' || role === 'arrow';
    const selectedStroke =
      role === 'highlight'
        ? withHighlightAlpha(stroke, highlightOpacity)
        : normalizeEditorColor(stroke);
    if (role === 'arrow') {
      if (!applyArrowStyle({ selected, fabric, stroke: selectedStroke, strokeWidth, dash })) return;
      canvas.requestRenderAll();
      scheduleHistory();
      return;
    }
    const properties = {
      stroke: selectedStroke,
      fill: isShape ? fill : selected.fill,
      strokeWidth,
      strokeDashArray: supportsDash && dash ? [strokeWidth * 2, strokeWidth * 2] : undefined,
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
    canvas.requestRenderAll();
    scheduleHistory();
  }, [
    canvasReady,
    canvasRef,
    dash,
    fabricRef,
    fill,
    highlightOpacity,
    scheduleHistory,
    stroke,
    strokeWidth,
  ]);
}
