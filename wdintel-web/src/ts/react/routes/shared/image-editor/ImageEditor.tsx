import { Alert, alpha, useTheme } from '@mui/material';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ImageEditorToolbar } from './ImageEditorToolbar';
import { ImageEditorContextToolbar } from './ImageEditorContextToolbar';
import { ImageEditorFooter } from './ImageEditorFooter';
import { ImageEditorDiscardAlert } from './ImageEditorDiscardAlert';
import { ImageEditorSaveDialogs } from './ImageEditorSaveDialogs';
import { ImageEditorWorkspace } from './ImageEditorWorkspace';
import { deleteSelectedAnnotations } from './image-editor-actions';
import {
  exportEditedImage,
  imageEditorOutputExtension,
  imageEditorOutputMimeType,
} from './image-editor-export';
import { restoreImageEditorCanvasReferences } from './image-editor-canvas-references';
import {
  applyCrop,
  cancelCrop,
  normalizeCrop,
  refreshCropMask,
  startCrop,
} from './image-editor-crop';
import { applyImageEditorInteractionMode } from './image-editor-interaction-mode';
import { replaceConcealmentArea as createConcealmentReplacement } from './image-editor-raster';
import type { ImageEditorBounds } from './image-editor-pointer';
import { useImageEditorCanvas } from './use-image-editor-canvas';
import { useImageEditorDrawingGestures } from './use-image-editor-drawing-gestures';
import { useImageEditorHistory } from './use-image-editor-history';
import { useImageEditorSelectionStyle } from './use-image-editor-selection-style';
import { useImageEditorSelection } from './use-image-editor-selection';
import { useImageEditorSaveDialogState } from './use-image-editor-save-dialog-state';
import { useImageEditorRasterQueue } from './use-image-editor-raster-queue';
import { useImageEditorViewport } from './use-image-editor-viewport';
import type {
  ConcealMode,
  EditedImageResult,
  ImageEditorSource,
  ImageEditorSelectionDescriptor,
  ImageEditorTool,
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
  const fabricRef = useRef<FabricModule | null>(null);
  const canvasRef = useRef<import('fabric').Canvas | null>(null);
  const sourceRef = useRef<import('fabric').FabricImage | null>(null);
  const cropRef = useRef<import('fabric').Rect | null>(null);
  const hiddenTextareaContainerRef = useRef<HTMLDivElement | null>(null);
  const saveAsNewButtonRef = useRef<HTMLButtonElement | null>(null);
  const saveReplacementButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelGestureRef = useRef<() => boolean>(() => false);
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
  const [textBackgroundColor, setTextBackgroundColor] = useState('#000000');
  const [textBackgroundEnabled, setTextBackgroundEnabled] = useState(false);
  const [textBackgroundPadding, setTextBackgroundPadding] = useState(6);
  const [highlightOpacity, setHighlightOpacity] = useState(0.4);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dismissMenu, setDismissMenu] = useState(0);
  const [canDeleteSelected, setCanDeleteSelected] = useState(false);
  const [selection, setSelection] = useState<ImageEditorSelectionDescriptor>();
  const outputExtension = imageEditorOutputExtension(imageEditorOutputMimeType(source));
  const saveDialogs = useImageEditorSaveDialogState({
    sourceFileName: source.fileName,
    outputExtension,
  });
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
  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);
  const changeTool = useCallback(
    (nextTool: ImageEditorTool) => {
      if (isInteractionLocked()) return;
      cancelGestureRef.current();
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
    onRestored: async (canvas, snapshot) => {
      restoreImageEditorCanvasReferences({
        canvas,
        sourceRef,
        cropRef,
        snapshot,
        hiddenTextareaContainer: hiddenTextareaContainerRef.current,
      });
      toolRef.current = 'select';
      setTool('select');
      syncDocumentDimensions({ fit: true });
      applyImageEditorInteractionMode({
        canvas,
        tool: 'select',
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
    if (!isInteractionLocked()) {
      cancelGestureRef.current();
      void enqueueRaster(undo);
    }
  }, [enqueueRaster, isInteractionLocked, undo]);
  const queuedRedo = useCallback(() => {
    if (!isInteractionLocked()) {
      cancelGestureRef.current();
      void enqueueRaster(redo);
    }
  }, [enqueueRaster, isInteractionLocked, redo]);
  const queuedReset = useCallback(() => {
    if (isInteractionLocked()) return;
    void enqueueRaster(async () => {
      cancelGestureRef.current();
      await resetEdits();
      const canvas = canvasRef.current;
      if (canvas) cancelCrop({ canvas, cropRef });
      toolRef.current = 'select';
      setTool('select');
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
    textBackgroundColor,
    textBackgroundEnabled,
    textBackgroundPadding,
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
    canvasReady,
    tool,
    toolRef,
    stroke,
    fill,
    strokeWidth,
    dash,
    fontSize,
    bold,
    textBackgroundColor,
    textBackgroundEnabled,
    textBackgroundPadding,
    concealMode,
    isInteractionLocked,
    saveHistory,
    replaceConcealmentArea,
    concealmentMarquee,
    cancelGestureRef,
    setError,
    hiddenTextareaContainer: hiddenTextareaContainerRef,
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
    onTextBackgroundColorChange: setTextBackgroundColor,
    onTextBackgroundEnabledChange: setTextBackgroundEnabled,
    onTextBackgroundPaddingChange: setTextBackgroundPadding,
    onHighlightOpacityChange: setHighlightOpacity,
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
  const save = async (destination: 'replacement' | 'new', basename?: string) => {
    const canvas = canvasRef.current;
    const sourceImage = sourceRef.current;
    if (!canvas || !sourceImage || isInteractionLocked()) return;
    cancelGestureRef.current();
    if (cropRef.current) {
      setError('Спочатку застосуйте або скасуйте обрізання');
      return;
    }
    flushScheduledHistory();
    applyingRef.current = true;
    setApplying(true);
    saveDialogs.setSaveError(null);
    setError(null);
    try {
      await flushRaster();
      const file = await exportEditedImage({
        canvas,
        source,
        sourceImage,
        outputBasename: basename,
      });
      if (destination === 'replacement') await onSaveReplacement({ file });
      else await onSaveAsNew({ file });
    } catch (cause) {
      saveDialogs.setSaveError(
        cause instanceof Error ? cause.message : 'Не вдалося зберегти зміни',
      );
      applyingRef.current = false;
      setApplying(false);
    }
  };
  const submitSaveAsNew = useCallback(() => {
    const basename = saveDialogs.validatedBasename();
    if (!basename) {
      saveDialogs.setFilenameError('Вкажіть коректну назву файлу');
      return;
    }
    saveDialogs.setFilenameError(null);
    saveDialogs.setSaveError(null);
    void save('new', basename);
  }, [save, saveDialogs]);
  const requestCancel = useCallback(() => {
    if (isInteractionLocked()) return;
    if (hasEdits) setConfirmCancel(true);
    else onCancel();
  }, [hasEdits, isInteractionLocked, onCancel]);
  const handleEditorEscape = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-image-editor-local-escape]'))
        return false;
      if (loading || applying || rasterPending) return true;
      if (saveDialogs.activeDialog === 'replacement') {
        saveDialogs.closeDialog('replacement');
        return true;
      }
      if (saveDialogs.activeDialog === 'new') {
        saveDialogs.closeDialog('new');
        return true;
      }
      if (confirmCancel) {
        setConfirmCancel(false);
        return true;
      }
      if (menuOpen) {
        setMenuOpen(false);
        setDismissMenu((value) => value + 1);
        return true;
      }
      const canvas = canvasRef.current;
      const active = canvas?.getActiveObject() as import('fabric').IText | undefined;
      if (active?.isEditing) {
        active.exitEditing();
        canvas?.requestRenderAll();
        return true;
      }
      if (cropRef.current) {
        cancelCropOperation();
        return true;
      }
      if (cancelGestureRef.current()) return true;
      requestCancel();
      return true;
    },
    [
      applying,
      cancelCropOperation,
      confirmCancel,
      loading,
      menuOpen,
      rasterPending,
      requestCancel,
      saveDialogs,
    ],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === 'Escape' && !registerEscapeHandler && handleEditorEscape(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const typing =
        target?.matches('input, textarea, select, [contenteditable="true"]') ||
        (canvasRef.current?.getActiveObject() as import('fabric').IText | undefined)?.isEditing ===
          true;
      if (typing || isInteractionLocked()) return;
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
      deleteSelected,
      handleEditorEscape,
      isInteractionLocked,
      queuedRedo,
      queuedUndo,
      registerEscapeHandler,
      tool,
    ],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onKeyDown]);
  useLayoutEffect(() => {
    if (!registerEscapeHandler) return;
    registerEscapeHandler(handleEditorEscape);
    return () => registerEscapeHandler(null);
  }, [handleEditorEscape, registerEscapeHandler]);
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
    onMenuOpenChange: setMenuOpen,
    dismissMenu,
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
    textBackgroundColor,
    onTextBackgroundColorChange: (value: string) => {
      setTextBackgroundColor(value);
      setTextBackgroundEnabled(true);
    },
    textBackgroundEnabled,
    onTextBackgroundEnabledChange: setTextBackgroundEnabled,
    textBackgroundPadding,
    onTextBackgroundPaddingChange: setTextBackgroundPadding,
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
        onSaveReplacement={() => void save('replacement')}
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
        cropActive={tool === 'crop' && Boolean(cropRef.current)}
        ready={canvasReady && !loading && !rasterPending}
        onCancel={requestCancel}
        onSaveReplacement={() => saveDialogs.openDialog('replacement', saveReplacementButtonRef)}
        onSaveAsNew={() => saveDialogs.openDialog('new', saveAsNewButtonRef)}
        saveAsNewButtonRef={saveAsNewButtonRef}
        saveReplacementButtonRef={saveReplacementButtonRef}
      />
      <div ref={hiddenTextareaContainerRef} data-image-editor-textarea-container />
    </section>
  );
}
