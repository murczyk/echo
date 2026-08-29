import { useEffect, type MutableRefObject } from 'react';

import { editorObjectRole, readImageEditorObjectStyle } from './image-editor-selection-style';
import {
  ImageEditorObjectRole,
  ImageEditorSelectionKind,
  type ImageEditorSelectionDescriptor,
} from './image-editor.types';
import { isImageEditorObjectRole, NON_DELETABLE_ROLES } from './image-editor-object-role';

function selectionDescriptor(
  selected: import('fabric').FabricObject,
  fabric: typeof import('fabric') | null,
): ImageEditorSelectionDescriptor | undefined {
  const role = fabric ? editorObjectRole(selected, fabric) : selected.get('editorRole');
  if (!isImageEditorObjectRole(role) || role === ImageEditorObjectRole.Source) return undefined;
  if (fabric && selected instanceof fabric.IText)
    return { kind: ImageEditorSelectionKind.Text, role };
  if (role === ImageEditorObjectRole.Rectangle || role === ImageEditorObjectRole.Ellipse)
    return { kind: ImageEditorSelectionKind.Shape, role };
  if (role === ImageEditorObjectRole.Line || role === ImageEditorObjectRole.Arrow)
    return { kind: ImageEditorSelectionKind.Line, role };
  if (role === ImageEditorObjectRole.Brush) return { kind: ImageEditorSelectionKind.Brush, role };
  if (role === ImageEditorObjectRole.Highlight)
    return { kind: ImageEditorSelectionKind.Highlight, role };
  if (role === ImageEditorObjectRole.Concealment)
    return { kind: ImageEditorSelectionKind.Concealment, role };
  return undefined;
}

export function useImageEditorSelection({
  canvasRef,
  fabricRef,
  canvasReady,
  onCanDeleteChange,
  onStrokeChange,
  onFillChange,
  onStrokeWidthChange,
  onDashChange,
  onFontSizeChange,
  onBoldChange,
  onTextBackgroundColorChange,
  onTextBackgroundEnabledChange,
  onTextBackgroundPaddingChange,
  onHighlightOpacityChange,
  onSelectionChange,
}: {
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  fabricRef: MutableRefObject<typeof import('fabric') | null>;
  canvasReady: boolean;
  onCanDeleteChange: (value: boolean) => void;
  onStrokeChange: (value: string) => void;
  onFillChange: (value: string) => void;
  onStrokeWidthChange: (value: number) => void;
  onDashChange: (value: boolean) => void;
  onFontSizeChange: (value: number) => void;
  onBoldChange: (value: boolean) => void;
  onTextBackgroundColorChange: (value: string) => void;
  onTextBackgroundEnabledChange: (value: boolean) => void;
  onTextBackgroundPaddingChange: (value: number) => void;
  onHighlightOpacityChange: (value: number) => void;
  onSelectionChange: (value: ImageEditorSelectionDescriptor | undefined) => void;
}) {
  useEffect(() => {
    const canvas = canvasRef.current;
    const fabric = fabricRef.current;
    if (!canvas) return;
    const sync = () => {
      const selected = canvas.getActiveObject();
      onCanDeleteChange(
        Boolean(
          selected &&
          (!isImageEditorObjectRole(selected.get('editorRole')) ||
            !NON_DELETABLE_ROLES.has(selected.get('editorRole'))),
        ),
      );
      if (!selected) {
        onSelectionChange(undefined);
        return;
      }
      const descriptor = selectionDescriptor(selected, fabric);
      onSelectionChange(descriptor);
      if (!descriptor) return;
      if (fabric && selected instanceof fabric.IText) {
        if (typeof selected.fill === 'string') onStrokeChange(selected.fill);
        if (typeof selected.fontSize === 'number') onFontSizeChange(selected.fontSize);
        onBoldChange(selected.fontWeight === 'bold');
        const text = selected as typeof selected & {
          annotationBackgroundColor?: unknown;
          annotationBackgroundEnabled?: unknown;
          annotationBackgroundPadding?: unknown;
        };
        if (typeof text.annotationBackgroundColor === 'string')
          onTextBackgroundColorChange(text.annotationBackgroundColor);
        onTextBackgroundEnabledChange(text.annotationBackgroundEnabled === true);
        if (typeof text.annotationBackgroundPadding === 'number')
          onTextBackgroundPaddingChange(text.annotationBackgroundPadding);
        return;
      }
      if (!fabric) return;
      const style = readImageEditorObjectStyle(selected, fabric);
      if (!style) return;
      onStrokeChange(style.stroke);
      if (style.fill) onFillChange(style.fill);
      onStrokeWidthChange(style.strokeWidth);
      onDashChange(style.dash);
      if (style.opacity != null) onHighlightOpacityChange(style.opacity);
    };
    canvas.on('selection:created', sync);
    canvas.on('selection:updated', sync);
    canvas.on('selection:cleared', sync);
    sync();
    return () => {
      canvas.off('selection:created', sync);
      canvas.off('selection:updated', sync);
      canvas.off('selection:cleared', sync);
    };
  }, [
    canvasReady,
    canvasRef,
    fabricRef,
    onBoldChange,
    onTextBackgroundColorChange,
    onTextBackgroundEnabledChange,
    onTextBackgroundPaddingChange,
    onHighlightOpacityChange,
    onCanDeleteChange,
    onDashChange,
    onFillChange,
    onFontSizeChange,
    onStrokeChange,
    onStrokeWidthChange,
    onSelectionChange,
  ]);
}
