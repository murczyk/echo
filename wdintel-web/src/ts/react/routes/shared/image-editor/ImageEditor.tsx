import { Alert, alpha, useTheme } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ImageEditorToolbar } from './ImageEditorToolbar';
import { ImageEditorContextToolbar } from './ImageEditorContextToolbar';
import { ImageEditorFooter } from './ImageEditorFooter';
import { ImageEditorDiscardAlert } from './ImageEditorDiscardAlert';
import { ImageEditorSaveDialogs } from './ImageEditorSaveDialogs';
import { ImageEditorWorkspace } from './ImageEditorWorkspace';
import { installImageEditorAttachedArrowControls } from './image-editor-attached-arrow';
import { restoreImageEditorCanvasReferences } from './image-editor-canvas-references';
import { cancelCrop, normalizeCrop, refreshCropMask, startCrop } from './image-editor-crop';
import { applyImageEditorInteractionMode } from './image-editor-interaction-mode';
import { replaceConcealmentArea as createConcealmentReplacement } from './image-editor-raster';
import type { ImageEditorBounds } from './image-editor-pointer';
import { useImageEditorCanvas } from './use-image-editor-canvas';
import { useImageEditorDrawingGestures } from './use-image-editor-drawing-gestures';
import { useImageEditorHistory } from './use-image-editor-history';
import { useImageEditorRasterQueue } from './use-image-editor-raster-queue';
import { useImageEditorStyleCoordination } from './use-image-editor-style-coordination';
import { useImageEditorKeyboardShortcuts } from './use-image-editor-keyboard-shortcuts';
import { useImageEditorAnnotationInteractions } from './use-image-editor-annotation-interactions';
import { useImageEditorSaveFlow } from './use-image-editor-save-flow';
import { useImageEditorViewport } from './use-image-editor-viewport';
import {
  ConcealMode,
  ImageEditorSaveDestination,
  ImageEditorSaveDialog,
  ImageEditorTool,
} from './image-editor.types';
import type {
  EditedImageResult,
  ImageEditorSource,
  RegisterImageEditorEscapeHandler,
} from './image-editor.types';
type FabricModule = typeof import('fabric');

export function ImageEditor({
  source,
  onCancel,
  onSaveReplacement,
  onSaveAsNew,
  registerEscapeHandler,
}: {
  source: ImageEditorSource;
  onCancel: () => void;
  onSaveReplacement: (result: EditedImageResult) => Promise<void> | void;
  onSaveAsNew: (result: EditedImageResult) => Promise<void> | void;
  registerEscapeHandler?: RegisterImageEditorEscapeHandler;
}) {
  const canvasElementRef = useRef<HTMLCanvasElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const editorRootRef = useRef<HTMLElement | null>(null);
  const editorIdRef = useRef(Symbol('image-editor'));
  const fabricRef = useRef<FabricModule | null>(null);
  const canvasRef = useRef<import('fabric').Canvas | null>(null);
  const sourceRef = useRef<import('fabric').FabricImage | null>(null);
  const cropRef = useRef<import('fabric').Rect | null>(null);
  const hiddenTextareaContainerRef = useRef<HTMLDivElement | null>(null);
  const saveAsNewButtonRef = useRef<HTMLButtonElement | null>(null);
  const saveReplacementButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelGestureRef = useRef<() => boolean>(() => false);
  const [tool, setTool] = useState<ImageEditorTool>(ImageEditorTool.Select);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const [canvasReady, setCanvasReady] = useState(false);
  const [concealMode, setConcealMode] = useState<ConcealMode>(ConcealMode.Blur);
  const [magnification, setMagnification] = useState(2);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dismissMenu, setDismissMenu] = useState(0);
  const theme = useTheme();
  const cropStroke = theme.palette.primary.main;
  const cropMaskColor = alpha(theme.palette.common.black, 0.38);
  const concealmentMarquee = {
    stroke: theme.palette.primary.main,
    fill: alpha(theme.palette.primary.main, 0.16),
  };
  const toolRef = useRef(tool);
  const {
    enqueue: enqueueRaster,
    flush: flushRaster,
    isBusy,
    pending: rasterPending,
  } = useImageEditorRasterQueue();
  const isInteractionLocked = useCallback(() => applyingRef.current || isBusy(), [isBusy]);
  const scheduleHistoryRef = useRef<() => void>(() => undefined);
  const refreshSelectionRef = useRef<() => void>(() => undefined);
  const cancelInteractionsRef = useRef<() => boolean>(() => false);
  const style = useImageEditorStyleCoordination({
    canvasRef,
    fabricRef,
    canvasReady,
    tool,
    scheduleHistory: () => scheduleHistoryRef.current(),
  });
  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  const changeTool = useCallback(
    (nextTool: ImageEditorTool, preserveSelection = false) => {
      if (isInteractionLocked()) return;
      const interactionsCancelled = cancelInteractionsRef.current();
      const canvas = canvasRef.current;
      toolRef.current = nextTool;
      if (canvas && nextTool !== ImageEditorTool.Crop && cropRef.current)
        cancelCrop({ canvas, cropRef });
      const active = preserveSelection ? canvas?.getActiveObject() : null;
      if (canvas)
        applyImageEditorInteractionMode({
          canvas,
          tool: nextTool,
          fabric: fabricRef.current,
          stroke: style.drawing.stroke,
          strokeWidth: style.activeStrokeWidth,
          highlightOpacity: style.drawing.highlightOpacity,
        });
      if (canvas && active) {
        canvas.setActiveObject(active);
        requestAnimationFrame(() => {
          if (canvasRef.current === canvas && active.canvas === canvas) {
            canvas.setActiveObject(active);
            canvas.requestRenderAll();
          }
        });
      }
      const fabric = fabricRef.current;
      if (canvas && fabric && nextTool === ImageEditorTool.Crop)
        startCrop({ canvas, fabric, cropRef, stroke: cropStroke, maskColor: cropMaskColor });
      setTool(nextTool);
      if (interactionsCancelled) canvas?.requestRenderAll();
    },
    [cropMaskColor, cropStroke, isInteractionLocked, style],
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
    onRestored: async (canvas, snapshot) => {
      restoreImageEditorCanvasReferences({
        canvas,
        sourceRef,
        cropRef,
        snapshot,
        hiddenTextareaContainer: hiddenTextareaContainerRef.current,
      });
      const fabric = fabricRef.current;
      if (fabric)
        installImageEditorAttachedArrowControls({
          canvas,
          fabric,
          onComplete: saveHistory,
          onChange: () => refreshSelectionRef.current(),
        });
      toolRef.current = ImageEditorTool.Select;
      setTool(ImageEditorTool.Select);
      syncDocumentDimensions({ fit: true });
      applyImageEditorInteractionMode({
        canvas,
        tool: ImageEditorTool.Select,
        fabric: fabricRef.current,
        stroke: style.drawing.stroke,
        strokeWidth: style.activeStrokeWidth,
        highlightOpacity: style.drawing.highlightOpacity,
      });
    },
    onRestoreError: (cause) =>
      setError(cause instanceof Error ? cause.message : 'Не вдалося відновити зміни'),
  });
  scheduleHistoryRef.current = scheduleHistory;
  refreshSelectionRef.current = style.refreshSelection;
  const {
    activeTextIsEditing,
    applyCropOperation,
    cancelCropOperation,
    cancelInteractions,
    deleteAttachedArrow,
    deleteSelected,
    finalizeActiveText,
  } = useImageEditorAnnotationInteractions({
    canvasRef,
    fabricRef,
    sourceRef,
    cropRef,
    cancelGestureRef,
    isInteractionLocked,
    saveHistory,
    flushScheduledHistory,
    refreshSelection: style.refreshSelection,
    changeTool,
    syncDocumentDimensions,
  });
  cancelInteractionsRef.current = cancelInteractions;

  const queuedUndo = useCallback(() => {
    if (!isInteractionLocked()) {
      cancelInteractionsRef.current();
      void enqueueRaster(undo);
    }
  }, [enqueueRaster, isInteractionLocked, undo]);
  const queuedRedo = useCallback(() => {
    if (!isInteractionLocked()) {
      cancelInteractionsRef.current();
      void enqueueRaster(redo);
    }
  }, [enqueueRaster, isInteractionLocked, redo]);
  const queuedReset = useCallback(() => {
    if (isInteractionLocked()) return;
    void enqueueRaster(async () => {
      cancelInteractionsRef.current();
      await resetEdits();
      const canvas = canvasRef.current;
      if (canvas) cancelCrop({ canvas, cropRef });
      toolRef.current = ImageEditorTool.Select;
      setTool(ImageEditorTool.Select);
      syncDocumentDimensions({ fit: true });
    });
  }, [enqueueRaster, isInteractionLocked, resetEdits, syncDocumentDimensions]);

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
    async (bounds: ImageEditorBounds, mode: ConcealMode) => {
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
          mode,
        });
        return changed;
      });
      if (created) {
        saveHistory();
      }
    },
    [enqueueRaster, saveHistory],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    applyImageEditorInteractionMode({
      canvas,
      tool: toolRef.current,
      fabric: fabricRef.current,
      stroke: style.drawing.stroke,
      strokeWidth: style.activeStrokeWidth,
      highlightOpacity: style.drawing.highlightOpacity,
    });
  }, [canvasReady]);

  useImageEditorDrawingGestures({
    canvasRef,
    fabricRef,
    canvasReady,
    tool,
    toolRef,
    stroke: style.drawing.stroke,
    fill: style.drawing.fill,
    strokeWidth: style.activeStrokeWidth,
    dash: style.drawing.dash,
    fontSize: style.drawing.fontSize,
    bold: style.drawing.bold,
    textBackgroundColor: style.drawing.textBackgroundColor,
    textBackgroundEnabled: style.drawing.textBackgroundEnabled,
    textBackgroundPadding: style.drawing.textBackgroundPadding,
    concealMode,
    isInteractionLocked,
    saveHistory,
    replaceConcealmentArea,
    concealmentMarquee,
    cancelGestureRef,
    setError,
    hiddenTextareaContainer: hiddenTextareaContainerRef,
    onTextClickAway: () => changeTool(ImageEditorTool.Select, true),
  });

  useEffect(
    () => () => {
      const canvas = canvasRef.current;
      if (canvas && cropRef.current) cancelCrop({ canvas, cropRef });
    },
    [],
  );

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
      stroke: style.drawing.stroke,
      strokeWidth: style.activeStrokeWidth,
      highlightOpacity: style.drawing.highlightOpacity,
    });
  }, [applying, rasterPending]);

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
    const normalizeCropFrame = (event: { target?: import('fabric').FabricObject }) => {
      if (event.target === cropRef.current)
        normalizeCrop({ canvas, fabric, cropRef, maskColor: cropMaskColor });
    };
    canvas.on('object:modified', normalizeCropFrame);
    return () => {
      canvas.off('object:moving', updateCropMask);
      canvas.off('object:scaling', updateCropMask);
      canvas.off('object:modified', normalizeCropFrame);
    };
  }, [canvasReady, cropMaskColor]);

  const { outputExtension, save, saveDialogs, submitSaveAsNew } = useImageEditorSaveFlow({
    source,
    canvasRef,
    sourceRef,
    fabricRef,
    cropRef,
    applyingRef,
    applying,
    setApplying,
    isInteractionLocked,
    cancelInteractions,
    finalizeActiveText,
    flushScheduledHistory,
    flushRaster,
    onSaveReplacement,
    onSaveAsNew,
    setError,
  });
  const requestCancel = useCallback(() => {
    if (isInteractionLocked()) return;
    const finalizedText = finalizeActiveText();
    if (hasEdits || finalizedText) setConfirmCancel(true);
    else onCancel();
  }, [finalizeActiveText, hasEdits, isInteractionLocked, onCancel]);
  const { activate } = useImageEditorKeyboardShortcuts({
    editorIdRef,
    editorRootRef,
    canvasRef,
    cropRef,
    cancelInteractions,
    loading,
    applying,
    rasterPending,
    saveDialogs,
    confirmCancel,
    menuOpen,
    setConfirmCancel,
    setMenuOpen,
    dismissMenu: () => setDismissMenu((value) => value + 1),
    finalizeActiveText,
    activeTextIsEditing,
    cancelCrop: cancelCropOperation,
    requestCancel,
    isInteractionLocked,
    changeTool,
    tool,
    applyCrop: applyCropOperation,
    undo: queuedUndo,
    redo: queuedRedo,
    deleteSelected,
    registerEscapeHandler,
  });
  const primaryToolbarProps = {
    disabled: !canvasReady || loading || applying || rasterPending,
    tool,
    onToolChange: changeTool,
    zoom,
    canUndo,
    canRedo,
    canDeleteSelected: style.canDeleteSelected,
    onDeleteSelected: deleteSelected,
    onZoomChange: setViewportZoom,
    onFitViewport: fitViewport,
    onActualSize: actualSize,
    onCenterViewport: centerViewport,
    onUndo: queuedUndo,
    onRedo: queuedRedo,
    onResetEdits: queuedReset,
    onMenuOpenChange: setMenuOpen,
    dismissMenu,
  };
  const contextualToolbarProps = {
    disabled: !canvasReady || loading || applying || rasterPending,
    tool,
    stroke: style.displayed.stroke,
    onStrokeChange: style.onStrokeChange,
    fill: style.displayed.fill,
    onFillChange: style.onFillChange,
    strokeWidth: style.displayed.strokeWidth,
    onStrokeWidthChange: style.onStrokeWidthChange,
    dash: style.displayed.dash,
    onDashChange: style.onDashChange,
    fontSize: style.displayed.fontSize,
    onFontSizeChange: style.onFontSizeChange,
    bold: style.displayed.bold,
    onBoldChange: style.onBoldChange,
    textBackgroundColor: style.displayed.textBackgroundColor,
    onTextBackgroundColorChange: style.onTextBackgroundColorChange,
    textBackgroundEnabled: style.displayed.textBackgroundEnabled,
    onTextBackgroundEnabledChange: style.onTextBackgroundEnabledChange,
    textBackgroundPadding: style.displayed.textBackgroundPadding,
    onTextBackgroundPaddingChange: style.onTextBackgroundPaddingChange,
    highlightOpacity: style.displayed.highlightOpacity,
    onHighlightOpacityChange: style.onHighlightOpacityChange,
    concealMode,
    onConcealModeChange: setConcealMode,
    magnification,
    onMagnificationChange: setMagnification,
    selection: style.selection,
    cropActive: tool === ImageEditorTool.Crop && Boolean(cropRef.current),
    onApplyCrop: applyCropOperation,
    onCancelCrop: cancelCropOperation,
    onDeleteAttachedArrow: deleteAttachedArrow,
  };
  return (
    <section
      ref={editorRootRef}
      data-image-editor-root
      className="flex min-h-0 flex-1 flex-col"
      aria-label="Редактор зображення"
      onPointerDownCapture={() => {
        activate();
      }}
      onFocusCapture={activate}
    >
      <ImageEditorToolbar {...primaryToolbarProps} />
      {error ? (
        <Alert severity="error" className="m-2">
          {error}
        </Alert>
      ) : null}
      {confirmCancel ? (
        <ImageEditorDiscardAlert onContinue={() => setConfirmCancel(false)} onDiscard={onCancel} />
      ) : null}
      <ImageEditorSaveDialogs
        activeDialog={saveDialogs.activeDialog}
        basename={saveDialogs.basename}
        disabled={applying}
        extension={outputExtension}
        filenameError={saveDialogs.filenameError}
        onBasenameChange={saveDialogs.setBasename}
        onClose={saveDialogs.closeDialog}
        onExited={saveDialogs.restoreFocusAfterExit}
        onSaveAsNew={submitSaveAsNew}
        onSaveReplacement={() => void save(ImageEditorSaveDestination.Replacement)}
        saveError={saveDialogs.saveError}
      />
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
        saving={applying}
        disabled={applying || rasterPending}
        cropActive={tool === ImageEditorTool.Crop && Boolean(cropRef.current)}
        ready={canvasReady && !loading && !rasterPending}
        onCancel={requestCancel}
        onSaveReplacement={() =>
          saveDialogs.openDialog(ImageEditorSaveDialog.Replacement, saveReplacementButtonRef)
        }
        onSaveAsNew={() => saveDialogs.openDialog(ImageEditorSaveDialog.New, saveAsNewButtonRef)}
        saveAsNewButtonRef={saveAsNewButtonRef}
        saveReplacementButtonRef={saveReplacementButtonRef}
      />
      <div ref={hiddenTextareaContainerRef} data-image-editor-textarea-container />
    </section>
  );
}
