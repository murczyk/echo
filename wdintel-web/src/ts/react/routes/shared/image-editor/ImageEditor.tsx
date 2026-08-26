import { Alert, alpha, useTheme } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ImageEditorToolbar } from './ImageEditorToolbar';
import { ImageEditorContextToolbar } from './ImageEditorContextToolbar';
import { ImageEditorFooter } from './ImageEditorFooter';
import { ImageEditorDiscardAlert } from './ImageEditorDiscardAlert';
import { ImageEditorWorkspace } from './ImageEditorWorkspace';
import { deleteSelectedAnnotations } from './image-editor-actions';
import { exportEditedImage } from './image-editor-export';
import { restoreImageEditorCanvasReferences } from './image-editor-canvas-references';
import { applyCrop, cancelCrop, refreshCropMask, startCrop } from './image-editor-crop';
import { applyImageEditorInteractionMode } from './image-editor-interaction-mode';
import { replaceConcealmentArea as createConcealmentReplacement } from './image-editor-raster';
import type { ImageEditorBounds } from './image-editor-pointer';
import { useImageEditorCanvas } from './use-image-editor-canvas';
import { useImageEditorDrawingGestures } from './use-image-editor-drawing-gestures';
import { useImageEditorHistory } from './use-image-editor-history';
import { useImageEditorSelectionStyle } from './use-image-editor-selection-style';
import { useImageEditorSelection } from './use-image-editor-selection';
import { useImageEditorRasterQueue } from './use-image-editor-raster-queue';
import { useImageEditorViewport } from './use-image-editor-viewport';
import type {
  ConcealMode,
  EditedImageResult,
  ImageEditorSource,
  ImageEditorSelectionDescriptor,
  ImageEditorTool,
} from './image-editor.types';
type FabricModule = typeof import('fabric');

export function ImageEditor({
  source,
  onCancel,
  onApply,
}: {
  source: ImageEditorSource;
  onCancel: () => void;
  onApply: (result: EditedImageResult) => Promise<void> | void;
}) {
  const canvasElementRef = useRef<HTMLCanvasElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const fabricRef = useRef<FabricModule | null>(null);
  const canvasRef = useRef<import('fabric').Canvas | null>(null);
  const sourceRef = useRef<import('fabric').FabricImage | null>(null);
  const cropRef = useRef<import('fabric').Rect | null>(null);
  const cancelGestureRef = useRef<() => void>(() => {});
  const [tool, setTool] = useState<ImageEditorTool>('select');
  const [stroke, setStroke] = useState('#ef4444');
  const [fill, setFill] = useState('transparent');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const [canvasReady, setCanvasReady] = useState(false);
  const [dash, setDash] = useState(false);
  const [concealMode, setConcealMode] = useState<ConcealMode>('blur');
  const [magnification, setMagnification] = useState(2);
  const [fontSize, setFontSize] = useState(36);
  const [bold, setBold] = useState(false);
  const [highlightOpacity, setHighlightOpacity] = useState(0.4);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [canDeleteSelected, setCanDeleteSelected] = useState(false);
  const [selection, setSelection] = useState<ImageEditorSelectionDescriptor>();
  const theme = useTheme();
  const cropStroke = theme.palette.primary.main;
  const cropMaskColor = alpha(theme.palette.text.primary, 0.38);
  const toolRef = useRef(tool);
  const {
    enqueue: enqueueRaster,
    flush: flushRaster,
    isBusy,
    pending: rasterPending,
  } = useImageEditorRasterQueue();
  const isInteractionLocked = useCallback(() => applyingRef.current || isBusy(), [isBusy]);
  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  const changeTool = useCallback(
    (nextTool: ImageEditorTool) => {
      if (isInteractionLocked()) return;
      const canvas = canvasRef.current;
      toolRef.current = nextTool;
      if (canvas && nextTool !== 'crop' && cropRef.current) cancelCrop({ canvas, cropRef });
      if (canvas)
        applyImageEditorInteractionMode({
          canvas,
          tool: nextTool,
          fabric: fabricRef.current,
          stroke,
          strokeWidth,
          highlightOpacity,
        });
      const fabric = fabricRef.current;
      if (canvas && fabric && nextTool === 'crop')
        startCrop({ canvas, fabric, cropRef, stroke: cropStroke, maskColor: cropMaskColor });
      setTool(nextTool);
    },
    [cropMaskColor, cropStroke, highlightOpacity, isInteractionLocked, stroke, strokeWidth],
  );
  const {
    actualSize,
    centerViewport,
    fitViewport,
    panBy,
    ready: viewportReady,
    setViewportZoom,
    syncDocumentDimensions,
    view,
    zoom,
    zoomAtPoint,
  } = useImageEditorViewport({ canvasRef, workspaceRef, canvasReady });

  const {
    canRedo,
    canUndo,
    clear: clearHistory,
    flushScheduledHistory,
    hasEdits,
    reset: resetEdits,
    redo,
    saveHistory,
    scheduleHistory,
    undo,
  } = useImageEditorHistory({
    canvasRef,
    onRestored: async (canvas) => {
      restoreImageEditorCanvasReferences({ canvas, sourceRef, cropRef });
      syncDocumentDimensions();
      applyImageEditorInteractionMode({
        canvas,
        tool: toolRef.current,
        fabric: fabricRef.current,
        stroke,
        strokeWidth,
        highlightOpacity,
      });
    },
    onRestoreError: (cause) =>
      setError(cause instanceof Error ? cause.message : 'Не вдалося відновити зміни'),
  });

  const queuedUndo = useCallback(() => {
    if (!isInteractionLocked()) void enqueueRaster(undo);
  }, [enqueueRaster, isInteractionLocked, undo]);
  const queuedRedo = useCallback(() => {
    if (!isInteractionLocked()) void enqueueRaster(redo);
  }, [enqueueRaster, isInteractionLocked, redo]);
  const queuedReset = useCallback(() => {
    if (!isInteractionLocked()) void enqueueRaster(resetEdits);
  }, [enqueueRaster, isInteractionLocked, resetEdits]);

  useImageEditorCanvas({
    source,
    canvasElementRef,
    fabricRef,
    canvasRef,
    sourceRef,
    cropRef,
    saveHistory,
    clearHistory,
    setCanvasReady,
    setLoading,
    setError,
    toolRef,
    onDocumentResized: syncDocumentDimensions,
  });

  const replaceConcealmentArea = useCallback(
    async (bounds: ImageEditorBounds) => {
      const canvas = canvasRef.current;
      const sourceImage = sourceRef.current;
      const fabric = fabricRef.current;
      if (!canvas || !sourceImage || !fabric) return;
      const created = await enqueueRaster(async () => {
        const changed = await createConcealmentReplacement({
          canvas,
          sourceImage,
          fabric,
          bounds,
          mode: concealMode,
        });
        return changed;
      });
      if (created) {
        saveHistory();
      }
    },
    [concealMode, enqueueRaster, saveHistory],
  );

  useImageEditorSelectionStyle({
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
    highlightOpacity,
    scheduleHistory,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    applyImageEditorInteractionMode({
      canvas,
      tool: toolRef.current,
      fabric: fabricRef.current,
      stroke,
      strokeWidth,
      highlightOpacity,
    });
  }, [canvasReady]);

  useImageEditorDrawingGestures({
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
    highlightOpacity,
    isInteractionLocked,
    saveHistory,
    replaceConcealmentArea,
    cancelGestureRef,
    setError,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (rasterPending || applying) {
      cancelGestureRef.current();
      canvas.selection = false;
      canvas.skipTargetFind = true;
      canvas.isDrawingMode = false;
      canvas.discardActiveObject();
      canvas.getObjects().forEach((object) => object.set({ selectable: false, evented: false }));
      canvas.requestRenderAll();
      return;
    }
    applyImageEditorInteractionMode({
      canvas,
      tool: toolRef.current,
      fabric: fabricRef.current,
      stroke,
      strokeWidth,
      highlightOpacity,
    });
  }, [applying, highlightOpacity, rasterPending, stroke, strokeWidth]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const fabric = fabricRef.current;
    if (!canvas || !fabric) return;
    const updateCropMask = (event: { target?: import('fabric').FabricObject }) => {
      if (event.target !== cropRef.current) return;
      refreshCropMask({ canvas, fabric, cropRef, maskColor: cropMaskColor });
    };
    canvas.on('object:moving', updateCropMask);
    canvas.on('object:scaling', updateCropMask);
    return () => {
      canvas.off('object:moving', updateCropMask);
      canvas.off('object:scaling', updateCropMask);
    };
  }, [canvasReady, cropMaskColor]);

  useImageEditorSelection({
    canvasRef,
    fabricRef,
    canvasReady,
    onCanDeleteChange: setCanDeleteSelected,
    onStrokeChange: setStroke,
    onFillChange: setFill,
    onStrokeWidthChange: setStrokeWidth,
    onDashChange: setDash,
    onFontSizeChange: setFontSize,
    onBoldChange: setBold,
    onSelectionChange: setSelection,
  });

  const deleteSelected = useCallback(() => {
    if (isInteractionLocked()) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    deleteSelectedAnnotations(canvas);
    saveHistory();
  }, [isInteractionLocked, saveHistory]);
  const applyCropOperation = useCallback(() => {
    if (isInteractionLocked()) return;
    const canvas = canvasRef.current;
    const sourceImage = sourceRef.current;
    if (!canvas || !sourceImage) return;
    if (applyCrop({ canvas, sourceImage, cropRef })) {
      saveHistory();
      syncDocumentDimensions({ fit: true });
      changeTool('select');
    }
  }, [changeTool, isInteractionLocked, saveHistory, syncDocumentDimensions]);
  const cancelCropOperation = useCallback(() => {
    if (isInteractionLocked()) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    cancelCrop({ canvas, cropRef });
    changeTool('select');
  }, [changeTool, isInteractionLocked]);
  const apply = async () => {
    const canvas = canvasRef.current;
    const sourceImage = sourceRef.current;
    if (!canvas || !sourceImage || isInteractionLocked()) return;
    if (cropRef.current) {
      setError('Спочатку застосуйте або скасуйте обрізання');
      return;
    }
    flushScheduledHistory();
    applyingRef.current = true;
    setApplying(true);
    setError(null);
    try {
      await flushRaster();
      const file = await exportEditedImage({
        canvas,
        source,
        sourceImage,
      });
      await onApply({ file });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не вдалося застосувати зміни');
      applyingRef.current = false;
      setApplying(false);
    }
  };
  const requestCancel = useCallback(() => {
    if (isInteractionLocked()) return;
    if (hasEdits) setConfirmCancel(true);
    else onCancel();
  }, [hasEdits, isInteractionLocked, onCancel]);
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const active = canvasRef.current?.getActiveObject() as import('fabric').IText | undefined;
      const typing =
        target?.matches('input, textarea, select, [contenteditable="true"]') ||
        active?.isEditing === true;
      if (typing || isInteractionLocked()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (cropRef.current && tool === 'crop') {
          cancelCropOperation();
        } else {
          requestCancel();
        }
        return;
      }
      if (event.key === 'Enter' && tool === 'crop' && cropRef.current) {
        event.preventDefault();
        applyCropOperation();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? queuedRedo() : queuedUndo();
      }
      if (event.key === 'y' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        queuedRedo();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelected();
      }
    },
    [
      applyCropOperation,
      cancelCropOperation,
      changeTool,
      deleteSelected,
      isInteractionLocked,
      queuedRedo,
      queuedUndo,
      requestCancel,
      saveHistory,
      tool,
    ],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);
  const primaryToolbarProps = {
    disabled: !canvasReady || loading || applying || rasterPending,
    tool,
    onToolChange: changeTool,
    zoom,
    canUndo,
    canRedo,
    canDeleteSelected,
    onDeleteSelected: deleteSelected,
    onZoomChange: setViewportZoom,
    onFitViewport: fitViewport,
    onActualSize: actualSize,
    onCenterViewport: centerViewport,
    onUndo: queuedUndo,
    onRedo: queuedRedo,
    onResetEdits: queuedReset,
  };
  const contextualToolbarProps = {
    disabled: !canvasReady || loading || applying || rasterPending,
    tool,
    stroke,
    onStrokeChange: setStroke,
    fill,
    onFillChange: setFill,
    strokeWidth,
    onStrokeWidthChange: setStrokeWidth,
    dash,
    onDashChange: setDash,
    fontSize,
    onFontSizeChange: setFontSize,
    bold,
    onBoldChange: () => setBold((value) => !value),
    highlightOpacity,
    onHighlightOpacityChange: setHighlightOpacity,
    concealMode,
    onConcealModeChange: setConcealMode,
    magnification,
    onMagnificationChange: setMagnification,
    selection,
    cropActive: tool === 'crop' && Boolean(cropRef.current),
    onApplyCrop: applyCropOperation,
    onCancelCrop: cancelCropOperation,
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Редактор зображення">
      <ImageEditorToolbar {...primaryToolbarProps} />
      {error ? (
        <Alert severity="error" className="m-2">
          {error}
        </Alert>
      ) : null}
      {confirmCancel ? (
        <ImageEditorDiscardAlert onContinue={() => setConfirmCancel(false)} onDiscard={onCancel} />
      ) : null}
      <ImageEditorWorkspace
        canvasElementRef={canvasElementRef}
        canvasRef={canvasRef}
        workspaceRef={workspaceRef}
        tool={tool}
        view={view}
        ready={viewportReady}
        loading={loading}
        busy={rasterPending || applying}
        magnification={magnification}
        onPan={panBy}
        onZoom={zoomAtPoint}
        contextualToolbar={<ImageEditorContextToolbar {...contextualToolbarProps} />}
      />
      <ImageEditorFooter
        applying={applying}
        disabled={applying || rasterPending}
        cropActive={tool === 'crop' && Boolean(cropRef.current)}
        ready={canvasReady && !loading && !rasterPending}
        onCancel={requestCancel}
        onApply={() => void apply()}
      />
    </section>
  );
}
