import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';

import { hasImageEditorAttachedArrow } from './image-editor-attached-arrow';
import { isImageEditorObjectRole, NON_DELETABLE_ROLES } from './image-editor-object-role';
import { editorObjectRole, readImageEditorObjectStyle } from './image-editor-selection-style';
import {
  ImageEditorObjectRole,
  ImageEditorSelectionKind,
  type ImageEditorSelectionDescriptor,
} from './image-editor.types';

function descriptor(
  selected: import('fabric').FabricObject,
  fabric: typeof import('fabric') | null,
): ImageEditorSelectionDescriptor | undefined {
  const role = fabric ? editorObjectRole(selected, fabric) : selected.get('editorRole');
  if (
    !isImageEditorObjectRole(role) ||
    role === ImageEditorObjectRole.Source ||
    role === ImageEditorObjectRole.DerivedArrow
  )
    return undefined;
  if (fabric && selected instanceof fabric.IText)
    return {
      kind: ImageEditorSelectionKind.Text,
      role,
      hasAttachedArrow: hasImageEditorAttachedArrow(selected),
    };
  if (role === ImageEditorObjectRole.Rectangle || role === ImageEditorObjectRole.Ellipse)
    return { kind: ImageEditorSelectionKind.Shape, role };
  if (role === ImageEditorObjectRole.Line || role === ImageEditorObjectRole.Arrow)
    return { kind: ImageEditorSelectionKind.Line, role };
  if (role === ImageEditorObjectRole.Brush || role === ImageEditorObjectRole.Highlight)
    return { kind: ImageEditorSelectionKind.Brush, role };
  return role === ImageEditorObjectRole.Concealment
    ? { kind: ImageEditorSelectionKind.Concealment, role }
    : undefined;
}

type Callbacks = {
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
};

export function useImageEditorSelection({
  canvasRef,
  fabricRef,
  canvasReady,
  ...callbacks
}: {
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  fabricRef: MutableRefObject<typeof import('fabric') | null>;
  canvasReady: boolean;
} & Callbacks) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const previousRef = useRef('');
  const syncRef = useRef<() => void>(() => {});
  const refreshSelection = useCallback(() => syncRef.current(), []);
  useEffect(() => {
    const canvas = canvasRef.current,
      fabric = fabricRef.current;
    if (!canvas) return;
    const sync = () => {
      const selected = canvas.getActiveObject();
      const selectedDescriptor = selected ? descriptor(selected, fabric) : undefined;
      const canDelete = Boolean(
        selected &&
        (!isImageEditorObjectRole(selected.get('editorRole')) ||
          !NON_DELETABLE_ROLES.has(selected.get('editorRole'))),
      );
      const key = JSON.stringify({ selectedDescriptor, canDelete });
      if (key !== previousRef.current) {
        previousRef.current = key;
        callbacksRef.current.onCanDeleteChange(canDelete);
        callbacksRef.current.onSelectionChange(selectedDescriptor);
      }
      if (!selected || !selectedDescriptor) return;
      if (fabric && selected instanceof fabric.IText) {
        if (typeof selected.fill === 'string') callbacksRef.current.onStrokeChange(selected.fill);
        if (typeof selected.fontSize === 'number')
          callbacksRef.current.onFontSizeChange(selected.fontSize);
        callbacksRef.current.onBoldChange(selected.fontWeight === 'bold');
        const text = selected as typeof selected & {
          annotationBackgroundColor?: unknown;
          annotationBackgroundEnabled?: unknown;
          annotationBackgroundPadding?: unknown;
        };
        if (typeof text.annotationBackgroundColor === 'string')
          callbacksRef.current.onTextBackgroundColorChange(text.annotationBackgroundColor);
        callbacksRef.current.onTextBackgroundEnabledChange(
          text.annotationBackgroundEnabled === true,
        );
        if (typeof text.annotationBackgroundPadding === 'number')
          callbacksRef.current.onTextBackgroundPaddingChange(text.annotationBackgroundPadding);
        return;
      }
      if (!fabric) return;
      const style = readImageEditorObjectStyle(selected, fabric);
      if (!style) return;
      callbacksRef.current.onStrokeChange(style.stroke);
      if (style.fill) callbacksRef.current.onFillChange(style.fill);
      callbacksRef.current.onStrokeWidthChange(style.strokeWidth);
      callbacksRef.current.onDashChange(style.dash);
      if (style.opacity != null) callbacksRef.current.onHighlightOpacityChange(style.opacity);
    };
    syncRef.current = sync;
    canvas.on('selection:created', sync);
    canvas.on('selection:updated', sync);
    canvas.on('selection:cleared', sync);
    (
      canvas as import('fabric').Canvas & { on: (eventName: string, callback: () => void) => void }
    ).on('image-editor:attached-arrow-changed', sync);
    sync();
    return () => {
      canvas.off('selection:created', sync);
      canvas.off('selection:updated', sync);
      canvas.off('selection:cleared', sync);
      (
        canvas as import('fabric').Canvas & {
          off: (eventName: string, callback: () => void) => void;
        }
      ).off('image-editor:attached-arrow-changed', sync);
      if (syncRef.current === sync) syncRef.current = () => {};
    };
  }, [canvasReady, canvasRef, fabricRef]);
  return { refreshSelection };
}
