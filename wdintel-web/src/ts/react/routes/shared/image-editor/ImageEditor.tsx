import { Alert } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ImageEditorToolbar } from './ImageEditorToolbar';
import { ImageEditorFooter } from './ImageEditorFooter';
import { ImageEditorDiscardAlert } from './ImageEditorDiscardAlert';
import { ImageEditorWorkspace } from './ImageEditorWorkspace';
import { addTextAnnotation, deleteSelectedAnnotations } from './image-editor-actions';
import { exportEditedImage } from './image-editor-export';
import { restoreImageEditorCanvasReferences } from './image-editor-canvas-references';
import { applyImageEditorInteractionMode } from './image-editor-interaction-mode';
import {
  addMagnifier as createMagnifier,
  magnifierGeometry,
  refreshMagnifier,
  refreshMagnifiers,
  replaceConcealmentDraft as createConcealmentReplacement,
} from './image-editor-raster';
import { useImageEditorCanvas } from './use-image-editor-canvas';
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
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [canDeleteSelected, setCanDeleteSelected] = useState(false);
  const [selection, setSelection] = useState<ImageEditorSelectionDescriptor>();
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
      if (canvas)
        applyImageEditorInteractionMode({
          canvas,
          tool: nextTool,
          fabric: fabricRef.current,
          stroke,
          strokeWidth,
        });
      setTool(nextTool);
    },
    [isInteractionLocked, stroke, strokeWidth],
  );
  const {
    actualSize,
    centerViewport,
    fitViewport,
    panBy,
    ready: viewportReady,
    setViewportZoom,
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
      applyImageEditorInteractionMode({
        canvas,
        tool: toolRef.current,
        fabric: fabricRef.current,
        stroke,
        strokeWidth,
      });
      if (sourceRef.current) await refreshMagnifiers({ canvas, sourceImage: sourceRef.current });
    },
    onRestoreError: (cause) =>
      setError(cause instanceof Error ? cause.message : 'Не вдалося відновити зміни'),
  });

  const handleMagnifierModified = useCallback(
    (magnifier: import('fabric').FabricObject) => {
      if (isInteractionLocked()) return;
      const canvas = canvasRef.current;
      const sourceImage = sourceRef.current;
      if (!canvas || !sourceImage) return;
      enqueueRaster(() => refreshMagnifier({ canvas, magnifier, sourceImage }))
        .then(saveHistory)
        .catch((cause) =>
          setError(cause instanceof Error ? cause.message : 'Не вдалося оновити лупу'),
        );
    },
    [enqueueRaster, isInteractionLocked, saveHistory],
  );
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
    onMagnifierModified: handleMagnifierModified,
  });

  const replaceConcealmentDraft = useCallback(
    async (draft: import('fabric').FabricObject) => {
      const canvas = canvasRef.current;
      const sourceImage = sourceRef.current;
      const fabric = fabricRef.current;
      if (!canvas || !sourceImage || !fabric) return;
      const created = await enqueueRaster(async () => {
        const changed = await createConcealmentReplacement({
          canvas,
          sourceImage,
          fabric,
          draft,
          mode: concealMode,
        });
        if (changed) await refreshMagnifiers({ canvas, sourceImage });
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
    scheduleHistory,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    applyImageEditorInteractionMode({
      canvas,
      tool: toolRef.current,
      fabric: fabricRef.current,
    });
  }, [canvasReady]);

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
    });
  }, [applying, rasterPending, stroke, strokeWidth]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const fabric = fabricRef.current;
    if (!canvas || !fabric) return;
    let start: { x: number; y: number } | null = null;
    let drawing: import('fabric').FabricObject | null = null;
    let magnifierPoint: { x: number; y: number } | null = null;
    let magnifierPreview: import('fabric').Circle | null = null;
    const clearGesture = () => {
      let removed = false;
      if (drawing) {
        canvas.remove(drawing);
        if (cropRef.current === drawing) cropRef.current = null;
        removed = true;
      }
      if (magnifierPreview) {
        canvas.remove(magnifierPreview);
        removed = true;
      }
      start = null;
      drawing = null;
      magnifierPoint = null;
      magnifierPreview = null;
      if (removed) canvas.requestRenderAll();
    };
    cancelGestureRef.current = clearGesture;
    const begin = (event: { scenePoint: { x: number; y: number } }) => {
      if (isInteractionLocked() || toolRef.current !== tool) return;
      if (tool === 'text') {
        addTextAnnotation({
          canvas,
          fabric,
          stroke,
          fontSize,
          bold,
          left: event.scenePoint.x,
          top: event.scenePoint.y,
        });
        saveHistory();
        return;
      }
      if (tool === 'magnifier') {
        start = event.scenePoint;
        magnifierPoint = event.scenePoint;
        magnifierPreview = new fabric.Circle({
          left: start.x,
          top: start.y,
          radius: 0,
          fill: 'transparent',
          stroke: getComputedStyle(canvas.upperCanvasEl ?? document.documentElement).color,
          strokeDashArray: [4, 4],
          selectable: false,
          evented: false,
          editorRole: 'magnifier-preview',
        });
        canvas.add(magnifierPreview);
        return;
      }
      if (!['crop', 'rectangle', 'ellipse', 'line', 'arrow', 'conceal'].includes(tool)) return;
      start = event.scenePoint;
      const common = {
        left: start.x,
        top: start.y,
        stroke,
        strokeWidth,
        fill,
        editorRole: tool === 'conceal' ? 'concealment-draft' : tool,
        strokeDashArray: dash && tool !== 'crop' ? [strokeWidth * 2, strokeWidth * 2] : undefined,
        selectable: false,
        evented: false,
      };
      drawing =
        tool === 'ellipse'
          ? new fabric.Ellipse({ ...common, rx: 1, ry: 1 })
          : tool === 'line' || tool === 'arrow'
            ? new fabric.Line([start.x, start.y, start.x, start.y], { ...common, fill: undefined })
            : new fabric.Rect({
                ...common,
                width: 1,
                height: 1,
                fill:
                  tool === 'crop'
                    ? 'rgba(59,130,246,0.15)'
                    : tool === 'conceal'
                      ? 'rgba(100,116,139,0.35)'
                      : fill,
                strokeDashArray: tool === 'crop' ? [12, 8] : common.strokeDashArray,
                selectable: false,
                evented: false,
              });
      if (tool === 'crop' && cropRef.current) canvas.remove(cropRef.current);
      canvas.add(drawing);
      if (tool === 'crop') cropRef.current = drawing as import('fabric').Rect;
    };
    const move = (event: { scenePoint: { x: number; y: number }; e?: { shiftKey?: boolean } }) => {
      if (isInteractionLocked()) {
        clearGesture();
        return;
      }
      if (start && tool === 'magnifier') {
        magnifierPoint = event.scenePoint;
        const sourceImage = sourceRef.current;
        const geometry = sourceImage
          ? magnifierGeometry({
              start,
              end: event.scenePoint,
              size: { width: sourceImage.width ?? 0, height: sourceImage.height ?? 0 },
            })
          : null;
        if (geometry)
          magnifierPreview?.set({
            left: geometry.left,
            top: geometry.top,
            radius: geometry.diameter / 2,
          });
        canvas.requestRenderAll();
        return;
      }
      if (!start || !drawing) return;
      const x = Math.min(start.x, event.scenePoint.x);
      const y = Math.min(start.y, event.scenePoint.y);
      const rawWidth = Math.abs(event.scenePoint.x - start.x);
      const rawHeight = Math.abs(event.scenePoint.y - start.y);
      const size = Math.max(rawWidth, rawHeight);
      const width = event.e?.shiftKey ? size : rawWidth;
      const height = event.e?.shiftKey ? size : rawHeight;
      if (drawing instanceof fabric.Line)
        drawing.set({ x2: event.scenePoint.x, y2: event.scenePoint.y });
      else if (drawing instanceof fabric.Ellipse)
        drawing.set({ left: x, top: y, rx: width / 2, ry: height / 2 });
      else drawing.set({ left: x, top: y, width, height });
      canvas.requestRenderAll();
    };
    const end = () => {
      if (isInteractionLocked()) {
        clearGesture();
        return;
      }
      if (drawing instanceof fabric.Line && tool === 'arrow') {
        const x1 = drawing.x1 ?? 0;
        const y1 = drawing.y1 ?? 0;
        const x2 = drawing.x2 ?? 0;
        const y2 = drawing.y2 ?? 0;
        const arrowHead = new fabric.Triangle({
          left: x2 - x1,
          top: y2 - y1,
          width: Math.max(12, strokeWidth * 4),
          height: Math.max(12, strokeWidth * 4),
          fill: stroke,
          angle: (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI + 90,
          originX: 'center',
          originY: 'center',
          selectable: false,
          evented: false,
        });
        canvas.remove(drawing);
        const shaft = new fabric.Line([0, 0, x2 - x1, y2 - y1], {
          stroke,
          strokeWidth,
          strokeDashArray: dash ? [strokeWidth * 2, strokeWidth * 2] : undefined,
          selectable: false,
          evented: false,
        });
        const arrow = new fabric.Group([shaft, arrowHead], { left: x1, top: y1 });
        arrow.set('editorRole' as never, 'arrow' as never);
        canvas.add(arrow);
        saveHistory();
      } else if (drawing && tool === 'conceal') {
        replaceConcealmentDraft(drawing).catch((cause) => {
          setError(cause instanceof Error ? cause.message : 'Не вдалося застосувати розмиття');
        });
      } else if (drawing) {
        if (tool === 'conceal') drawing.set({ selectable: false, evented: false });
        saveHistory();
      }
      if (magnifierPreview) canvas.remove(magnifierPreview);
      if (!drawing && start && tool === 'magnifier' && sourceRef.current && magnifierPoint) {
        const magnifierStart = start;
        const magnifierEnd = magnifierPoint;
        enqueueRaster(() =>
          createMagnifier({
            canvas,
            sourceImage: sourceRef.current!,
            fabric,
            magnification,
            bounds: {
              left: magnifierStart.x,
              top: magnifierStart.y,
              width: magnifierEnd.x - magnifierStart.x,
              height: magnifierEnd.y - magnifierStart.y,
            },
          }),
        )
          .then((created) => {
            if (created) saveHistory();
          })
          .catch((cause) =>
            setError(cause instanceof Error ? cause.message : 'Не вдалося створити лупу'),
          );
      }
      start = null;
      drawing = null;
      magnifierPoint = null;
      magnifierPreview = null;
    };
    canvas.on('mouse:down', begin);
    canvas.on('mouse:move', move);
    canvas.on('mouse:up', end);
    return () => {
      clearGesture();
      cancelGestureRef.current = () => {};
      canvas.off('mouse:down', begin);
      canvas.off('mouse:move', move);
      canvas.off('mouse:up', end);
    };
  }, [
    canvasReady,
    concealMode,
    dash,
    fill,
    replaceConcealmentDraft,
    saveHistory,
    stroke,
    strokeWidth,
    tool,
    fontSize,
    bold,
    magnification,
    isInteractionLocked,
  ]);

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
  const apply = async () => {
    const canvas = canvasRef.current;
    const sourceImage = sourceRef.current;
    if (!canvas || !sourceImage || isInteractionLocked()) return;
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
        crop: cropRef.current,
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
          canvasRef.current?.remove(cropRef.current);
          cropRef.current = null;
          saveHistory();
        } else {
          requestCancel();
        }
        return;
      }
      if (event.key === 'Enter' && tool === 'crop' && cropRef.current) {
        event.preventDefault();
        changeTool('select');
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
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Редактор зображення">
      <ImageEditorToolbar
        disabled={!canvasReady || loading || applying || rasterPending}
        tool={tool}
        onToolChange={changeTool}
        stroke={stroke}
        onStrokeChange={setStroke}
        fill={fill}
        onFillChange={setFill}
        strokeWidth={strokeWidth}
        onStrokeWidthChange={setStrokeWidth}
        dash={dash}
        onDashChange={setDash}
        fontSize={fontSize}
        onFontSizeChange={setFontSize}
        bold={bold}
        onBoldChange={() => setBold((value) => !value)}
        concealMode={concealMode}
        onConcealModeChange={setConcealMode}
        magnification={magnification}
        onMagnificationChange={setMagnification}
        zoom={zoom}
        canUndo={canUndo}
        canRedo={canRedo}
        canDeleteSelected={canDeleteSelected}
        selection={selection}
        onDeleteSelected={deleteSelected}
        onZoomChange={setViewportZoom}
        onFitViewport={fitViewport}
        onActualSize={actualSize}
        onCenterViewport={centerViewport}
        onUndo={queuedUndo}
        onRedo={queuedRedo}
        onResetEdits={queuedReset}
      />
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
        workspaceRef={workspaceRef}
        tool={tool}
        view={view}
        ready={viewportReady}
        loading={loading}
        busy={rasterPending || applying}
        onPan={panBy}
        onZoom={zoomAtPoint}
      />
      <ImageEditorFooter
        applying={applying}
        disabled={applying || rasterPending}
        ready={canvasReady && !loading && !rasterPending}
        onCancel={requestCancel}
        onApply={() => void apply()}
      />
    </section>
  );
}
