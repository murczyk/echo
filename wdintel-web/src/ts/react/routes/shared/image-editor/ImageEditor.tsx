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
  installImageEditorAttachedArrowControls,
  removeImageEditorAttachedArrow,
  reconcileImageEditorAttachedArrows,
  cancelImageEditorAttachedArrowGesture,
} from './image-editor-attached-arrow';
import { imageEditorToolFromKeyboardEvent } from './image-editor-shortcuts';
import { loadImageEditorFonts } from './image-editor-font';
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
import {
  applyImageEditorInteractionMode,
  updateImageEditorBrushStyle,
} from './image-editor-interaction-mode';
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
import {
  ConcealMode,
  ImageEditorSaveDestination,
  ImageEditorSaveDialog,
  ImageEditorTool,
} from './image-editor.types';
import type {
  EditedImageResult,
  ImageEditorSource,
  ImageEditorSelectionDescriptor,
  RegisterImageEditorEscapeHandler,
} from './image-editor.types';
type FabricModule = typeof import('fabric');

let activeImageEditor: symbol | null = null;

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
  const [selection, setSelection] = useState<ImageEditorSelectionDescriptor>();
  const [stroke, setStroke] = useState('#ef4444');
  const [fill, setFill] = useState('transparent');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [brushWidth, setBrushWidth] = useState(7);
  const activeStrokeWidth =
    tool === ImageEditorTool.Brush || selection?.kind === 'brush' ? brushWidth : strokeWidth;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const [canvasReady, setCanvasReady] = useState(false);
  const [dash, setDash] = useState(false);
  const [concealMode, setConcealMode] = useState<ConcealMode>(ConcealMode.Blur);
  const [magnification, setMagnification] = useState(2);
  const [fontSize, setFontSize] = useState(36);
  const [bold, setBold] = useState(false);
  const [textBackgroundColor, setTextBackgroundColor] = useState('#ffffff');
  const [textBackgroundEnabled, setTextBackgroundEnabled] = useState(true);
  const [textBackgroundPadding, setTextBackgroundPadding] = useState(6);
  const [highlightOpacity, setHighlightOpacity] = useState(1);
  const [selectedStyle, setSelectedStyle] = useState({
    stroke: '#ef4444',
    fill: 'transparent',
    strokeWidth: 4,
    dash: false,
    fontSize: 36,
    bold: false,
    textBackgroundColor: '#ffffff',
    textBackgroundEnabled: true,
    textBackgroundPadding: 6,
    highlightOpacity: 1,
  });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dismissMenu, setDismissMenu] = useState(0);
  const [canDeleteSelected, setCanDeleteSelected] = useState(false);
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
  useEffect(() => {
    activeImageEditor = editorIdRef.current;
    return () => {
      if (activeImageEditor === editorIdRef.current) activeImageEditor = null;
    };
  }, []);
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
    (nextTool: ImageEditorTool, preserveSelection = false) => {
      if (isInteractionLocked()) return;
      const arrowGestureCancelled = canvasRef.current
        ? cancelImageEditorAttachedArrowGesture(canvasRef.current)
        : false;
      cancelGestureRef.current();
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
          stroke,
          strokeWidth: activeStrokeWidth,
          highlightOpacity,
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
      if (arrowGestureCancelled) canvas?.requestRenderAll();
    },
    [activeStrokeWidth, cropMaskColor, cropStroke, highlightOpacity, isInteractionLocked, stroke],
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
          onChange: refreshSelection,
        });
      toolRef.current = ImageEditorTool.Select;
      setTool(ImageEditorTool.Select);
      syncDocumentDimensions({ fit: true });
      applyImageEditorInteractionMode({
        canvas,
        tool: ImageEditorTool.Select,
        fabric: fabricRef.current,
        stroke,
        strokeWidth: activeStrokeWidth,
        highlightOpacity,
      });
    },
    onRestoreError: (cause) =>
      setError(cause instanceof Error ? cause.message : 'Не вдалося відновити зміни'),
  });

  const queuedUndo = useCallback(() => {
    if (!isInteractionLocked()) {
      cancelGestureRef.current();
      if (canvasRef.current) cancelImageEditorAttachedArrowGesture(canvasRef.current);
      void enqueueRaster(undo);
    }
  }, [enqueueRaster, isInteractionLocked, undo]);
  const queuedRedo = useCallback(() => {
    if (!isInteractionLocked()) {
      cancelGestureRef.current();
      if (canvasRef.current) cancelImageEditorAttachedArrowGesture(canvasRef.current);
      void enqueueRaster(redo);
    }
  }, [enqueueRaster, isInteractionLocked, redo]);
  const queuedReset = useCallback(() => {
    if (isInteractionLocked()) return;
    void enqueueRaster(async () => {
      cancelGestureRef.current();
      if (canvasRef.current) cancelImageEditorAttachedArrowGesture(canvasRef.current);
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

  const showingSelectionStyle = selection != null;
  const displayedStroke = showingSelectionStyle ? selectedStyle.stroke : stroke;
  const displayedFill = showingSelectionStyle ? selectedStyle.fill : fill;
  const displayedStrokeWidth = showingSelectionStyle
    ? selectedStyle.strokeWidth
    : activeStrokeWidth;
  const displayedDash = showingSelectionStyle ? selectedStyle.dash : dash;
  const displayedFontSize = showingSelectionStyle ? selectedStyle.fontSize : fontSize;
  const displayedBold = showingSelectionStyle ? selectedStyle.bold : bold;
  const displayedBackgroundColor = showingSelectionStyle
    ? selectedStyle.textBackgroundColor
    : textBackgroundColor;
  const displayedBackgroundEnabled = showingSelectionStyle
    ? selectedStyle.textBackgroundEnabled
    : textBackgroundEnabled;
  const displayedBackgroundPadding = showingSelectionStyle
    ? selectedStyle.textBackgroundPadding
    : textBackgroundPadding;
  const displayedHighlightOpacity = showingSelectionStyle
    ? selectedStyle.highlightOpacity
    : highlightOpacity;

  const { applySelectedStyle } = useImageEditorSelectionStyle({
    canvasRef,
    fabricRef,
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
      strokeWidth: activeStrokeWidth,
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
    strokeWidth: activeStrokeWidth,
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
      stroke,
      strokeWidth: activeStrokeWidth,
      highlightOpacity,
    });
  }, [applying, rasterPending]);

  useEffect(() => {
    if (tool !== ImageEditorTool.Brush) return;
    updateImageEditorBrushStyle({
      canvas: canvasRef.current,
      stroke,
      strokeWidth: brushWidth,
      highlightOpacity,
    });
  }, [brushWidth, highlightOpacity, stroke, tool]);

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

  const { refreshSelection } = useImageEditorSelection({
    canvasRef,
    fabricRef,
    canvasReady,
    onCanDeleteChange: setCanDeleteSelected,
    onStrokeChange: (stroke) => setSelectedStyle((style) => ({ ...style, stroke })),
    onFillChange: (fill) => setSelectedStyle((style) => ({ ...style, fill })),
    onStrokeWidthChange: (strokeWidth) => setSelectedStyle((style) => ({ ...style, strokeWidth })),
    onDashChange: (dash) => setSelectedStyle((style) => ({ ...style, dash })),
    onFontSizeChange: (fontSize) => setSelectedStyle((style) => ({ ...style, fontSize })),
    onBoldChange: (bold) => setSelectedStyle((style) => ({ ...style, bold })),
    onTextBackgroundColorChange: (textBackgroundColor) =>
      setSelectedStyle((style) => ({ ...style, textBackgroundColor })),
    onTextBackgroundEnabledChange: (textBackgroundEnabled) =>
      setSelectedStyle((style) => ({ ...style, textBackgroundEnabled })),
    onTextBackgroundPaddingChange: (textBackgroundPadding) =>
      setSelectedStyle((style) => ({ ...style, textBackgroundPadding })),
    onHighlightOpacityChange: (highlightOpacity) =>
      setSelectedStyle((style) => ({ ...style, highlightOpacity })),
    onSelectionChange: setSelection,
  });

  const deleteSelected = useCallback(() => {
    if (isInteractionLocked()) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    deleteSelectedAnnotations(canvas);
    const fabric = fabricRef.current;
    if (fabric) reconcileImageEditorAttachedArrows({ canvas, fabric });
    refreshSelection();
    saveHistory();
  }, [isInteractionLocked, refreshSelection, saveHistory]);
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
  }, [isInteractionLocked, refreshSelection, saveHistory]);
  const applyCropOperation = useCallback(() => {
    if (isInteractionLocked()) return;
    const canvas = canvasRef.current;
    const sourceImage = sourceRef.current;
    if (!canvas || !sourceImage) return;
    if (applyCrop({ canvas, sourceImage, cropRef })) {
      const fabric = fabricRef.current;
      if (fabric) reconcileImageEditorAttachedArrows({ canvas, fabric });
      saveHistory();
      syncDocumentDimensions({ fit: true });
      changeTool(ImageEditorTool.Select);
    }
  }, [changeTool, isInteractionLocked, saveHistory, syncDocumentDimensions]);
  const cancelCropOperation = useCallback(() => {
    if (isInteractionLocked()) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    cancelCrop({ canvas, cropRef });
    changeTool(ImageEditorTool.Select);
  }, [changeTool, isInteractionLocked]);
  const finalizeActiveText = useCallback(() => {
    const canvas = canvasRef.current;
    const active = canvas?.getActiveObject() as import('fabric').IText | undefined;
    if (!canvas || !active?.isEditing) return false;
    active.exitEditing();
    canvas.requestRenderAll();
    flushScheduledHistory();
    return Boolean(active.text?.trim());
  }, [flushScheduledHistory]);
  const save = async (destination: ImageEditorSaveDestination, basename?: string) => {
    const canvas = canvasRef.current;
    const sourceImage = sourceRef.current;
    if (!canvas || !sourceImage || isInteractionLocked()) return;
    cancelGestureRef.current();
    cancelImageEditorAttachedArrowGesture(canvas);
    finalizeActiveText();
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
      await loadImageEditorFonts();
      const fabric = fabricRef.current;
      if (fabric) reconcileImageEditorAttachedArrows({ canvas, fabric });
      const file = await exportEditedImage({
        canvas,
        source,
        sourceImage,
        outputBasename: basename,
      });
      if (destination === ImageEditorSaveDestination.Replacement) await onSaveReplacement({ file });
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
    void save(ImageEditorSaveDestination.New, basename);
  }, [save, saveDialogs]);
  const requestCancel = useCallback(() => {
    if (isInteractionLocked()) return;
    const finalizedText = finalizeActiveText();
    if (hasEdits || finalizedText) setConfirmCancel(true);
    else onCancel();
  }, [finalizeActiveText, hasEdits, isInteractionLocked, onCancel]);
  const handleEditorEscape = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-image-editor-local-escape]'))
        return false;
      if (loading || applying || rasterPending) return true;
      if (saveDialogs.activeDialog === ImageEditorSaveDialog.Replacement) {
        saveDialogs.closeDialog(ImageEditorSaveDialog.Replacement);
        return true;
      }
      if (saveDialogs.activeDialog === ImageEditorSaveDialog.New) {
        saveDialogs.closeDialog(ImageEditorSaveDialog.New);
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
      if (canvas && cancelImageEditorAttachedArrowGesture(canvas)) return true;
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
      const target = event.target instanceof Element ? event.target : null;
      const targetIsInsideEditor = Boolean(target?.closest('[data-image-editor-root]'));
      const isNativeControl = Boolean(
        target?.closest(
          'button, input, textarea, select, option, [contenteditable="true"], [role="slider"]',
        ),
      );
      if (!targetIsInsideEditor && activeImageEditor !== editorIdRef.current) return;
      if (event.key === 'Escape' && !registerEscapeHandler && handleEditorEscape(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const typing =
        event.isComposing ||
        isNativeControl ||
        (canvasRef.current?.getActiveObject() as import('fabric').IText | undefined)?.isEditing ===
          true;
      if (typing || isInteractionLocked() || saveDialogs.activeDialog || confirmCancel || menuOpen)
        return;
      const shortcutTool = imageEditorToolFromKeyboardEvent(event);
      if (shortcutTool) {
        event.preventDefault();
        event.stopPropagation();
        changeTool(shortcutTool);
        return;
      }
      if (event.key === 'Enter' && tool === ImageEditorTool.Crop && cropRef.current) {
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
      confirmCancel,
      deleteSelected,
      handleEditorEscape,
      isInteractionLocked,
      queuedRedo,
      queuedUndo,
      registerEscapeHandler,
      saveDialogs.activeDialog,
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
    stroke: displayedStroke,
    onStrokeChange: (value: string) => {
      const result = applySelectedStyle({
        property: 'stroke',
        value,
        highlightOpacity: displayedHighlightOpacity,
      });
      if (result === true) setSelectedStyle((style) => ({ ...style, stroke: value }));
      else if (result === undefined) setStroke(value);
    },
    fill: displayedFill,
    onFillChange: (value: string) => {
      const result = applySelectedStyle({ property: 'fill', value });
      if (result === true) setSelectedStyle((style) => ({ ...style, fill: value }));
      else if (result === undefined) setFill(value);
    },
    strokeWidth: displayedStrokeWidth,
    onStrokeWidthChange: (value: number) => {
      const result = applySelectedStyle({ property: 'strokeWidth', value });
      if (result === true) {
        setSelectedStyle((style) => ({ ...style, strokeWidth: value }));
        return;
      }
      if (result === false) return;
      if (tool === ImageEditorTool.Brush) setBrushWidth(value);
      else setStrokeWidth(value);
    },
    dash: displayedDash,
    onDashChange: (value: boolean) => {
      const result = applySelectedStyle({ property: 'dash', value });
      if (result === true) setSelectedStyle((style) => ({ ...style, dash: value }));
      else if (result === undefined) setDash(value);
    },
    fontSize: displayedFontSize,
    onFontSizeChange: (value: number) => {
      const result = applySelectedStyle({ property: 'fontSize', value });
      if (result === true) setSelectedStyle((style) => ({ ...style, fontSize: value }));
      else if (result === undefined) setFontSize(value);
    },
    bold: displayedBold,
    onBoldChange: () => {
      const value = !displayedBold;
      const result = applySelectedStyle({ property: 'bold', value });
      if (result === true) setSelectedStyle((style) => ({ ...style, bold: value }));
      else if (result === undefined) setBold(value);
    },
    textBackgroundColor: displayedBackgroundColor,
    onTextBackgroundColorChange: (value: string) => {
      const result = applySelectedStyle({ property: 'textBackgroundColor', value });
      if (result === true) setSelectedStyle((style) => ({ ...style, textBackgroundColor: value }));
      else if (result === undefined) {
        setTextBackgroundColor(value);
        setTextBackgroundEnabled(true);
      }
    },
    textBackgroundEnabled: displayedBackgroundEnabled,
    onTextBackgroundEnabledChange: (value: boolean) => {
      const result = applySelectedStyle({ property: 'textBackgroundEnabled', value });
      if (result === true)
        setSelectedStyle((style) => ({ ...style, textBackgroundEnabled: value }));
      else if (result === undefined) setTextBackgroundEnabled(value);
    },
    textBackgroundPadding: displayedBackgroundPadding,
    onTextBackgroundPaddingChange: (value: number) => {
      const result = applySelectedStyle({ property: 'textBackgroundPadding', value });
      if (result === true)
        setSelectedStyle((style) => ({ ...style, textBackgroundPadding: value }));
      else if (result === undefined) setTextBackgroundPadding(value);
    },
    highlightOpacity: displayedHighlightOpacity,
    onHighlightOpacityChange: (value: number) => {
      const result = applySelectedStyle({ property: 'highlightOpacity', value });
      if (result === true) setSelectedStyle((style) => ({ ...style, highlightOpacity: value }));
      else if (result === undefined) setHighlightOpacity(value);
    },
    concealMode,
    onConcealModeChange: setConcealMode,
    magnification,
    onMagnificationChange: setMagnification,
    selection,
    cropActive: tool === ImageEditorTool.Crop && Boolean(cropRef.current),
    onApplyCrop: applyCropOperation,
    onCancelCrop: cancelCropOperation,
    onDeleteAttachedArrow: deleteAttachedArrow,
  };
  return (
    <section
      data-image-editor-root
      className="flex min-h-0 flex-1 flex-col"
      aria-label="Редактор зображення"
      onPointerDownCapture={() => {
        activeImageEditor = editorIdRef.current;
      }}
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
