import { CircularProgress } from '@mui/material';
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import type { EditorViewState } from './image-editor-viewport';
import { calculateMagnifierSample } from './image-editor-magnifier';
import { applyImageEditorSurfaceCursor, imageEditorCursor } from './image-editor-interaction-mode';
import { ImageEditorTool } from './image-editor.types';

export function ImageEditorWorkspace({
  canvasElementRef,
  canvasRef,
  workspaceRef,
  tool,
  view,
  ready,
  loading,
  busy,
  magnification,
  onPan,
  onZoom,
  contextualToolbar,
}: {
  canvasElementRef: RefObject<HTMLCanvasElement | null>;
  canvasRef: RefObject<import('fabric').Canvas | null>;
  workspaceRef: RefObject<HTMLDivElement | null>;
  tool: ImageEditorTool;
  view: EditorViewState;
  ready: boolean;
  loading: boolean;
  busy: boolean;
  magnification: number;
  onPan: (delta: { x: number; y: number }) => void;
  onZoom: (point: { x: number; y: number }, scale: number) => void;
  contextualToolbar?: ReactNode;
}) {
  const dragRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const spaceDownRef = useRef(false);
  const lensCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lensFrameRef = useRef<number | null>(null);
  const lensPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const [lens, setLens] = useState<{ left: number; top: number } | null>(null);
  const [panDragging, setPanDragging] = useState(false);
  const lensDiameter = 144;
  const zoomRef = useRef({ busy, onZoom, scale: view.scale });
  zoomRef.current = { busy, onZoom, scale: view.scale };
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const zoom = (event: WheelEvent) => {
      const current = zoomRef.current;
      if (current.busy) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = workspace.getBoundingClientRect();
      current.onZoom(
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        current.scale * (event.deltaY > 0 ? 0.9 : 1.1),
      );
    };
    workspace.addEventListener('wheel', zoom, { passive: false });
    return () => workspace.removeEventListener('wheel', zoom);
  }, [workspaceRef]);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.code === 'Space' &&
        !target?.matches('input, textarea, select, [contenteditable="true"]')
      )
        spaceDownRef.current = true;
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceDownRef.current = false;
    };
    const blur = () => {
      spaceDownRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      spaceDownRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (busy) {
      dragRef.current = null;
      setPanDragging(false);
    }
  }, [busy]);
  useEffect(() => {
    applyImageEditorSurfaceCursor(canvasRef.current, busy ? 'wait' : imageEditorCursor(tool));
  }, [busy, canvasRef, tool]);
  const hideLens = () => {
    lensPointerRef.current = null;
    if (lensFrameRef.current != null) cancelAnimationFrame(lensFrameRef.current);
    lensFrameRef.current = null;
    setLens(null);
  };
  useEffect(() => hideLens, []);
  useEffect(() => {
    if (tool !== ImageEditorTool.Magnifier || busy) hideLens();
  }, [busy, tool]);

  const updateLens = (event: PointerEvent<HTMLDivElement>) => {
    if (tool !== ImageEditorTool.Magnifier || busy) return;
    lensPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
    if (lensFrameRef.current != null) return;
    lensFrameRef.current = requestAnimationFrame(() => {
      lensFrameRef.current = null;
      const pointer = lensPointerRef.current;
      const workspace = workspaceRef.current;
      const element = canvasRef.current?.lowerCanvasEl;
      const lensCanvas = lensCanvasRef.current;
      if (!pointer || !workspace || !element || !lensCanvas) return;
      const imageBounds = element.getBoundingClientRect();
      if (imageBounds.width <= 0 || imageBounds.height <= 0) {
        setLens(null);
        return;
      }
      if (
        pointer.clientX < imageBounds.left ||
        pointer.clientX > imageBounds.right ||
        pointer.clientY < imageBounds.top ||
        pointer.clientY > imageBounds.bottom
      ) {
        setLens(null);
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const backingSize = lensDiameter * dpr;
      if (lensCanvas.width !== backingSize || lensCanvas.height !== backingSize) {
        lensCanvas.width = backingSize;
        lensCanvas.height = backingSize;
      }
      const context = lensCanvas.getContext('2d');
      if (!context) return;
      const sample = calculateMagnifierSample({
        canvasSize: { width: element.width, height: element.height },
        displayedSize: { width: imageBounds.width, height: imageBounds.height },
        pointer: { x: pointer.clientX - imageBounds.left, y: pointer.clientY - imageBounds.top },
        lensDiameter,
        magnification,
      });
      if (!sample) return;
      context.clearRect(0, 0, backingSize, backingSize);
      context.save();
      context.beginPath();
      context.arc(backingSize / 2, backingSize / 2, backingSize / 2, 0, Math.PI * 2);
      context.clip();
      context.drawImage(
        element,
        sample.left,
        sample.top,
        sample.width,
        sample.height,
        0,
        0,
        backingSize,
        backingSize,
      );
      context.restore();
      const workspaceBounds = workspace.getBoundingClientRect();
      setLens({
        left: pointer.clientX - workspaceBounds.left - lensDiameter / 2,
        top: pointer.clientY - workspaceBounds.top - lensDiameter / 2,
      });
    });
  };

  const beginPan = (event: PointerEvent<HTMLDivElement>) => {
    if (busy) return;
    if (tool !== ImageEditorTool.Pan && !spaceDownRef.current && event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    setPanDragging(true);
    applyImageEditorSurfaceCursor(canvasRef.current, 'grabbing');
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    if (busy) {
      dragRef.current = null;
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    onPan({ x: event.clientX - drag.x, y: event.clientY - drag.y });
    dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
  };
  const endPan = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    event.stopPropagation();
    dragRef.current = null;
    setPanDragging(false);
    applyImageEditorSurfaceCursor(canvasRef.current, busy ? 'wait' : imageEditorCursor(tool));
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      ref={workspaceRef as RefObject<HTMLDivElement>}
      data-image-editor-workspace
      aria-busy={busy}
      className="relative min-h-0 flex-1 overflow-hidden bg-echo-surface touch-none"
      style={{ cursor: busy ? 'wait' : panDragging ? 'grabbing' : imageEditorCursor(tool) }}
      onPointerDownCapture={beginPan}
      onPointerMoveCapture={movePan}
      onPointerMove={updateLens}
      onPointerUpCapture={endPan}
      onPointerCancelCapture={endPan}
      onPointerLeave={hideLens}
    >
      {contextualToolbar}
      {loading ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-echo-text">
          <CircularProgress size={24} /> Завантаження зображення…
        </div>
      ) : null}
      <div
        data-image-editor-document
        className="absolute left-1/2 top-1/2 origin-center border border-echo-border shadow-echo-lg"
        style={{
          transform: `translate(calc(-50% + ${view.pan.x}px), calc(-50% + ${view.pan.y}px))`,
          visibility: ready && !loading ? 'visible' : 'hidden',
        }}
      >
        <canvas ref={canvasElementRef as RefObject<HTMLCanvasElement>} />
      </div>
      {tool === ImageEditorTool.Magnifier && !busy ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-20 size-36 rounded-full border-2 border-echo-border bg-echo-surface shadow-echo-lg"
          style={{
            left: lens?.left ?? 0,
            top: lens?.top ?? 0,
            visibility: lens ? 'visible' : 'hidden',
          }}
        >
          <canvas ref={lensCanvasRef} className="size-full rounded-full" />
        </div>
      ) : null}
    </div>
  );
}
