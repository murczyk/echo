import { useEffect, type MutableRefObject } from 'react';

import { editorObjectRole, readImageEditorObjectStyle } from './image-editor-selection-style';
import type { ImageEditorSelectionDescriptor } from './image-editor.types';

function selectionDescriptor(
  selected: import('fabric').FabricObject,
  fabric: typeof import('fabric') | null,
): ImageEditorSelectionDescriptor | undefined {
  const role = fabric ? editorObjectRole(selected, fabric) : selected.get('editorRole');
  if (typeof role !== 'string' || role === 'source') return undefined;
  if (fabric && selected instanceof fabric.IText) return { kind: 'text', role };
  if (role === 'rectangle' || role === 'ellipse') return { kind: 'shape', role };
  if (role === 'line' || role === 'arrow') return { kind: 'line', role };
  if (role === 'brush') return { kind: 'brush', role };
  if (role === 'highlight') return { kind: 'highlight', role };
  if (role === 'concealment') return { kind: 'concealment', role };
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
          !['concealment', 'crop', 'crop-mask'].includes(String(selected.get('editorRole'))),
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
