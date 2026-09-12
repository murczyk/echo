import { useCallback, type MutableRefObject } from 'react';

import { reconcileImageEditorAttachedArrows } from './image-editor-attached-arrow';
import {
  applyArrowStyle,
  editorObjectRole,
  normalizeEditorColor,
  readImageEditorObjectStyle,
  withHighlightAlpha,
} from './image-editor-selection-style';
import {
  DASH_SUPPORTING_ROLES,
  SHAPE_ROLES,
  STYLEABLE_ANNOTATION_ROLES,
} from './image-editor-object-role';
import { ImageEditorObjectRole } from './image-editor.types';

export type ImageEditorSelectedStyleChange =
  | { property: 'stroke'; value: string; highlightOpacity: number }
  | { property: 'fill'; value: string }
  | { property: 'strokeWidth'; value: number }
  | { property: 'dash'; value: boolean }
  | { property: 'fontSize'; value: number }
  | { property: 'bold'; value: boolean }
  | { property: 'textBackgroundColor'; value: string }
  | { property: 'textBackgroundEnabled'; value: boolean }
  | { property: 'textBackgroundPadding'; value: number }
  | { property: 'highlightOpacity'; value: number };

export function useImageEditorSelectionStyle({
  canvasRef,
  fabricRef,
  scheduleHistory,
}: {
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  fabricRef: MutableRefObject<typeof import('fabric') | null>;
  scheduleHistory: () => void;
}) {
  const applySelectedStyle = useCallback(
    (change: ImageEditorSelectedStyleChange) => {
      const canvas = canvasRef.current;
      const fabric = fabricRef.current;
      const selected = canvas?.getActiveObject();
      if (!canvas || !fabric || !selected) return undefined;

      if (selected instanceof fabric.IText) {
        const text = selected as typeof selected & {
          annotationBackgroundColor?: string;
          annotationBackgroundEnabled?: boolean;
          annotationBackgroundPadding?: number;
        };
        const properties =
          change.property === 'stroke'
            ? { fill: change.value }
            : change.property === 'fontSize'
              ? { fontSize: change.value }
              : change.property === 'bold'
                ? { fontWeight: change.value ? 'bold' : 'normal' }
                : change.property === 'textBackgroundColor'
                  ? { annotationBackgroundColor: change.value }
                  : change.property === 'textBackgroundEnabled'
                    ? { annotationBackgroundEnabled: change.value }
                    : change.property === 'textBackgroundPadding'
                      ? { annotationBackgroundPadding: change.value }
                      : null;
        if (
          !properties ||
          Object.entries(properties).every(([key, value]) => text.get(key) === value)
        )
          return properties ? false : undefined;
        text.set(properties as never);
        reconcileImageEditorAttachedArrows({ canvas, fabric });
        canvas.requestRenderAll();
        scheduleHistory();
        return true;
      }

      const role = editorObjectRole(selected, fabric);
      if (!role || !STYLEABLE_ANNOTATION_ROLES.has(role)) return undefined;
      const isShape = SHAPE_ROLES.has(role);
      const supportsDash = DASH_SUPPORTING_ROLES.has(role);
      if (change.property === 'fill' && !isShape) return undefined;
      if (change.property === 'dash' && !supportsDash) return undefined;
      if (
        change.property === 'highlightOpacity' &&
        role !== ImageEditorObjectRole.Highlight &&
        role !== ImageEditorObjectRole.Brush
      )
        return undefined;

      if (role === ImageEditorObjectRole.Arrow) {
        if (!['stroke', 'strokeWidth', 'dash'].includes(change.property)) return undefined;
        const currentStyle = readImageEditorObjectStyle(selected, fabric);
        if (!currentStyle) return undefined;
        const stroke =
          change.property === 'stroke' ? normalizeEditorColor(change.value) : currentStyle.stroke;
        const strokeWidth =
          change.property === 'strokeWidth' ? change.value : currentStyle.strokeWidth;
        const dash = change.property === 'dash' ? change.value : currentStyle.dash;
        if (!applyArrowStyle({ selected, fabric, stroke, strokeWidth, dash })) return false;
      } else {
        const properties: Record<string, unknown> = {};
        if (change.property === 'stroke')
          properties.stroke =
            role === ImageEditorObjectRole.Highlight || role === ImageEditorObjectRole.Brush
              ? withHighlightAlpha(change.value, change.highlightOpacity)
              : normalizeEditorColor(change.value);
        if (change.property === 'highlightOpacity')
          properties.stroke = withHighlightAlpha(
            String(selected.stroke ?? '#ef4444'),
            change.value,
          );
        if (change.property === 'fill') properties.fill = change.value;
        if (change.property === 'strokeWidth') {
          properties.strokeWidth = change.value;
          if (supportsDash && (selected.strokeDashArray?.length ?? 0) > 0)
            properties.strokeDashArray = [change.value * 2, change.value * 2];
        }
        if (change.property === 'dash')
          properties.strokeDashArray = change.value
            ? [Number(selected.strokeWidth ?? 4) * 2, Number(selected.strokeWidth ?? 4) * 2]
            : undefined;
        if (
          Object.entries(properties).every(
            ([key, value]) => JSON.stringify(selected.get(key)) === JSON.stringify(value),
          )
        )
          return false;
        selected.set(properties);
      }
      canvas.requestRenderAll();
      scheduleHistory();
      return true;
    },
    [canvasRef, fabricRef, scheduleHistory],
  );

  return { applySelectedStyle };
}
