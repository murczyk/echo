import { Alert, Button, CircularProgress } from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ImageEditorToolbar } from './ImageEditorToolbar';
import { addTextAnnotation, deleteSelectedAnnotations } from './image-editor-actions';
import { exportEditedImage } from './image-editor-export';
import { restoreImageEditorCanvasReferences } from './image-editor-canvas-references';
import {
  addMagnifier as createMagnifier,
  replaceConcealmentDraft as createConcealmentReplacement,
} from './image-editor-raster';
import { useImageEditorCanvas } from './use-image-editor-canvas';
import { useImageEditorHistory } from './use-image-editor-history';
import { useImageEditorPan } from './use-image-editor-pan';
import { useImageEditorSelectionStyle } from './use-image-editor-selection-style';
import { useImageEditorViewport } from './use-image-editor-viewport';
import type {
  ConcealMode,
  EditedImageResult,
  ImageEditorSource,
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
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fabricRef = useRef<FabricModule | null>(null);
  const canvasRef = useRef<import('fabric').Canvas | null>(null);
  const sourceRef = useRef<import('fabric').FabricImage | null>(null);
  const cropRef = useRef<import('fabric').Rect | null>(null);
  const [tool, setTool] = useState<ImageEditorTool>('select');
  const [stroke, setStroke] = useState('#ef4444');
  const [fill, setFill] = useState('transparent');
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [canvasReady, setCanvasReady] = useState(false);
  const [dash, setDash] = useState(false);
  const [concealMode, setConcealMode] = useState<ConcealMode>('pixelate');
  const [magnification, setMagnification] = useState(2);
  const [fontSize, setFontSize] = useState(36);
  const [bold, setBold] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const { actualSize, cssScale, fitViewport, pan, resetViewport, setPan, setViewportZoom, zoom } =
    useImageEditorViewport({ canvasRef, viewportRef, canvasReady });

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
    onRestored: (canvas) => restoreImageEditorCanvasReferences({ canvas, sourceRef, cropRef }),
    onRestoreError: (cause) =>
      setError(cause instanceof Error ? cause.message : 'Не вдалося відновити зміни'),
  });

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
  });

  const replaceConcealmentDraft = useCallback(
    async (draft: import('fabric').FabricObject) => {
      const canvas = canvasRef.current;
      const sourceImage = sourceRef.current;
      const fabric = fabricRef.current;
      if (!canvas || !sourceImage || !fabric) return;
      await createConcealmentReplacement({ canvas, sourceImage, fabric, draft, mode: concealMode });
      saveHistory();
    },
    [concealMode, saveHistory],
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
    const fabric = fabricRef.current;
    if (!canvas || !fabric) return;
    let start: { x: number; y: number } | null = null;
    let drawing: import('fabric').FabricObject | null = null;
    const begin = (event: { scenePoint: { x: number; y: number }; e?: { altKey?: boolean } }) => {
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
        const selected = canvas.getActiveObject();
        if (event.e?.altKey && selected?.get('editorRole') === 'magnifier' && sourceRef.current) {
          const calloutPoint = {
            x: (selected.left ?? 0) + 120,
            y: (selected.top ?? 0) + 120,
          };
          const magnifierId = selected.get('magnifierId');
          const previousMagnifier = canvas
            .getObjects()
            .filter((object) => object.get('magnifierId') === magnifierId);
          void createMagnifier({
            canvas,
            sourceImage: sourceRef.current,
            fabric,
            magnification,
            stroke,
            strokeWidth,
            sourcePoint: event.scenePoint,
            calloutPoint,
          })
            .then(() => {
              previousMagnifier.forEach((object) => canvas.remove(object));
              saveHistory();
            })
            .catch((cause) =>
              setError(cause instanceof Error ? cause.message : 'Не вдалося оновити лупу'),
            );
          return;
        }
        start = event.scenePoint;
        return;
      }
      if (tool === 'conceal' && concealMode === 'whole-blur' && sourceRef.current) {
        const source = sourceRef.current;
        const draft = new fabric.Rect({
          left: 0,
          top: 0,
          width: source.width ?? canvas.width,
          height: source.height ?? canvas.height,
          editorRole: 'concealment',
        });
        void replaceConcealmentDraft(draft).catch((cause) =>
          setError(cause instanceof Error ? cause.message : 'Не вдалося розмити зображення'),
        );
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
        editorRole: tool === 'conceal' ? 'concealment' : tool,
        strokeDashArray: dash && tool !== 'crop' ? [strokeWidth * 2, strokeWidth * 2] : undefined,
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
                      ? concealMode === 'redact'
                        ? '#000000'
                        : concealMode === 'blur' || concealMode === 'whole-blur'
                          ? 'rgba(148,163,184,0.75)'
                          : 'rgba(82,82,82,0.85)'
                      : fill,
                strokeDashArray: tool === 'crop' ? [12, 8] : common.strokeDashArray,
                selectable: true,
                evented: true,
              });
      if (tool === 'crop' && cropRef.current) canvas.remove(cropRef.current);
      canvas.add(drawing);
      if (tool === 'crop') cropRef.current = drawing as import('fabric').Rect;
    };
    const move = (event: { scenePoint: { x: number; y: number }; e?: { shiftKey?: boolean } }) => {
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
        canvas.setActiveObject(arrow);
        saveHistory();
      } else if (drawing && tool === 'conceal' && concealMode !== 'redact') {
        void replaceConcealmentDraft(drawing).catch((cause) => {
          setError(
            cause instanceof Error ? cause.message : 'Не вдалося приховати виділену область',
          );
        });
      } else if (drawing) {
        if (tool === 'conceal') drawing.set({ selectable: false, evented: false });
        saveHistory();
      }
      if (!drawing && start && tool === 'magnifier' && sourceRef.current) {
        void createMagnifier({
          canvas,
          sourceImage: sourceRef.current!,
          fabric,
          magnification,
          stroke,
          strokeWidth,
          sourcePoint: start,
          calloutPoint: { x: start.x + 160, y: start.y + 160 },
        })
          .then(() => saveHistory())
          .catch((cause) =>
            setError(cause instanceof Error ? cause.message : 'Не вдалося створити лупу'),
          );
      }
      start = null;
      drawing = null;
    };
    canvas.on('mouse:down', begin);
    canvas.on('mouse:move', move);
    canvas.on('mouse:up', end);
    return () => {
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
  ]);

  useImageEditorPan({ canvasRef, fabricRef, cssScale, tool, setPan, setViewportZoom });

  const deleteSelected = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    deleteSelectedAnnotations(canvas);
    saveHistory();
  };
  const apply = async () => {
    const canvas = canvasRef.current;
    const sourceImage = sourceRef.current;
    if (!canvas || !sourceImage || applying) return;
    flushScheduledHistory();
    setApplying(true);
    setError(null);
    try {
      const file = await exportEditedImage({
        canvas,
        source,
        sourceImage,
        crop: cropRef.current,
      });
      await onApply({ file });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не вдалося застосувати зміни');
      setApplying(false);
    }
  };
  const requestCancel = () => {
    if (hasEdits) setConfirmCancel(true);
    else onCancel();
  };
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const active = canvasRef.current?.getActiveObject() as import('fabric').IText | undefined;
      const typing =
        target?.matches('input, textarea, select, [contenteditable="true"]') ||
        active?.isEditing === true;
      if (typing) return;
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
        setTool('select');
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        void (event.shiftKey ? redo() : undo());
      }
      if (event.key === 'y' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void redo();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelected();
      }
    },
    [deleteSelected, redo, requestCancel, saveHistory, tool, undo],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      tabIndex={-1}
      aria-label="Редактор зображення"
    >
      <ImageEditorToolbar
        disabled={!canvasReady || loading || applying}
        tool={tool}
        onToolChange={setTool}
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
        onDeleteSelected={deleteSelected}
        onZoomChange={setViewportZoom}
        onFitViewport={fitViewport}
        onActualSize={actualSize}
        onResetViewport={resetViewport}
        onUndo={() => void undo()}
        onRedo={() => void redo()}
        onResetEdits={() => void resetEdits()}
      />
      {error ? (
        <Alert severity="error" className="m-2">
          {error}
        </Alert>
      ) : null}
      {confirmCancel ? (
        <Alert
          severity="warning"
          className="m-2"
          action={
            <span className="flex gap-1">
              <Button
                type="button"
                color="inherit"
                size="small"
                onClick={() => setConfirmCancel(false)}
              >
                Продовжити
              </Button>
              <Button
                type="button"
                color="inherit"
                size="small"
                onClick={(event) => {
                  event.stopPropagation();
                  onCancel();
                }}
              >
                Відкинути
              </Button>
            </span>
          }
        >
          Є незастосовані зміни.
        </Alert>
      ) : null}
      {tool === 'conceal' ? (
        <Alert severity="warning" className="mx-2 mt-2">
          Для надійного приховування конфіденційних даних використовуйте «Редакція». Розмиття й
          пікселізація не гарантують незворотного приховування.
        </Alert>
      ) : null}
      {tool === 'magnifier' ? (
        <Alert severity="info" className="mx-2 mt-2">
          Клацніть зображення, щоб вибрати область для лупи. Виберіть лупу та Alt+клацніть, щоб
          змінити її джерело; перетягуйте лупу, щоб змінити лише її розташування.
        </Alert>
      ) : null}
      <div ref={viewportRef} className="min-h-0 flex-1 overflow-auto bg-black p-3">
        <canvas ref={canvasElementRef} className="mx-auto block max-h-full max-w-full" />
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-echo-border p-2">
        <Button type="button" onClick={requestCancel} disabled={applying}>
          Скасувати
        </Button>
        <Button
          variant="contained"
          type="button"
          onClick={() => void apply()}
          disabled={!canvasReady || loading || applying}
        >
          {applying ? <CircularProgress size={18} color="inherit" /> : 'Застосувати'}
        </Button>
      </footer>
    </section>
  );
}
