import { useCallback, type MutableRefObject } from 'react';

import { deleteSelectedAnnotations } from './image-editor-actions';
import {
  cancelImageEditorAttachedArrowGesture,
  reconcileImageEditorAttachedArrows,
  removeImageEditorAttachedArrow,
} from './image-editor-attached-arrow';
import { applyCrop, cancelCrop } from './image-editor-crop';
import { ImageEditorTool } from './image-editor.types';

export function useImageEditorAnnotationInteractions({
  canvasRef,
  fabricRef,
  sourceRef,
  cropRef,
  cancelGestureRef,
  isInteractionLocked,
  saveHistory,
  flushScheduledHistory,
  refreshSelection,
  changeTool,
  syncDocumentDimensions,
}: {
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  fabricRef: MutableRefObject<typeof import('fabric') | null>;
  sourceRef: MutableRefObject<import('fabric').FabricImage | null>;
  cropRef: MutableRefObject<import('fabric').Rect | null>;
  cancelGestureRef: MutableRefObject<() => boolean>;
  isInteractionLocked: () => boolean;
  saveHistory: () => void;
  flushScheduledHistory: () => void;
  refreshSelection: () => void;
  changeTool: (tool: ImageEditorTool) => void;
  syncDocumentDimensions: (options: { fit: boolean }) => void;
}) {
  const cancelInteractions = useCallback(() => {
    const canvas = canvasRef.current;
    const drawingCancelled = cancelGestureRef.current();
    const arrowCancelled = canvas ? cancelImageEditorAttachedArrowGesture(canvas) : false;
    return drawingCancelled || arrowCancelled;
  }, [cancelGestureRef, canvasRef]);
  const finalizeActiveText = useCallback(() => {
    const canvas = canvasRef.current;
    const active = canvas?.getActiveObject() as import('fabric').IText | undefined;
    if (!canvas || !active?.isEditing) return false;
    active.exitEditing();
    canvas.requestRenderAll();
    flushScheduledHistory();
    return Boolean(active.text?.trim());
  }, [canvasRef, flushScheduledHistory]);
  const activeTextIsEditing = useCallback(() => {
    const active = canvasRef.current?.getActiveObject() as import('fabric').IText | undefined;
    return Boolean(active?.isEditing);
  }, [canvasRef]);
  const deleteSelected = useCallback(() => {
    if (isInteractionLocked()) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    deleteSelectedAnnotations(canvas);
    const fabric = fabricRef.current;
    if (fabric) reconcileImageEditorAttachedArrows({ canvas, fabric });
    refreshSelection();
    saveHistory();
  }, [canvasRef, fabricRef, isInteractionLocked, refreshSelection, saveHistory]);
  const deleteAttachedArrow = useCallback(() => {
    const canvas = canvasRef.current;
    const fabric = fabricRef.current;
    const selected = canvas?.getActiveObject();
    if (!canvas || !fabric || !(selected instanceof fabric.IText) || isInteractionLocked()) return;
    removeImageEditorAttachedArrow(canvas, selected);
    reconcileImageEditorAttachedArrows({ canvas, fabric });
    canvas.requestRenderAll();
    saveHistory();
    refreshSelection();
  }, [canvasRef, fabricRef, isInteractionLocked, refreshSelection, saveHistory]);
  const applyCropOperation = useCallback(() => {
    if (isInteractionLocked()) return;
    const canvas = canvasRef.current;
    const sourceImage = sourceRef.current;
    if (!canvas || !sourceImage || !applyCrop({ canvas, sourceImage, cropRef })) return;
    const fabric = fabricRef.current;
    if (fabric) reconcileImageEditorAttachedArrows({ canvas, fabric });
    saveHistory();
    syncDocumentDimensions({ fit: true });
    changeTool(ImageEditorTool.Select);
  }, [
    canvasRef,
    changeTool,
    cropRef,
    fabricRef,
    isInteractionLocked,
    saveHistory,
    sourceRef,
    syncDocumentDimensions,
  ]);
  const cancelCropOperation = useCallback(() => {
    if (isInteractionLocked()) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    cancelCrop({ canvas, cropRef });
    changeTool(ImageEditorTool.Select);
  }, [canvasRef, changeTool, cropRef, isInteractionLocked]);
  return {
    activeTextIsEditing,
    applyCropOperation,
    cancelInteractions,
    cancelCropOperation,
    deleteAttachedArrow,
    deleteSelected,
    finalizeActiveText,
  };
}
