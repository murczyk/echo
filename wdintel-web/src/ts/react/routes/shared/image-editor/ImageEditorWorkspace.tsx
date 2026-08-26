import { CircularProgress } from '@mui/material';
import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

import type { EditorViewState } from './image-editor-viewport';
import type { ImageEditorTool } from './image-editor.types';

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
}) {
  const dragRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const spaceDownRef = useRef(false);
  const [lens, setLens] = useState<{
    left: number;
    top: number;
    image: string;
    backgroundSize: string;
    backgroundPosition: string;
  } | null>(null);
  const lensDiameter = 144;
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
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
  useEffect(() => {
    if (busy) dragRef.current = null;
  }, [busy]);
  useEffect(() => {
    if (tool !== 'magnifier' || busy) setLens(null);
  }, [busy, tool]);

  const updateLens = (event: PointerEvent<HTMLDivElement>) => {
    if (tool !== 'magnifier' || busy) return;
    const canvas = canvasRef.current;
    const workspace = workspaceRef.current;
    const element = canvas?.lowerCanvasEl;
    if (!canvas || !workspace || !element) return;
    const imageBounds = element.getBoundingClientRect();
    if (
      event.clientX < imageBounds.left ||
      event.clientX > imageBounds.right ||
      event.clientY < imageBounds.top ||
      event.clientY > imageBounds.bottom
    ) {
      setLens(null);
      return;
    }
    const workspaceBounds = workspace.getBoundingClientRect();
    const x = event.clientX - imageBounds.left;
    const y = event.clientY - imageBounds.top;
    setLens({
      left: event.clientX - workspaceBounds.left - lensDiameter / 2,
      top: event.clientY - workspaceBounds.top - lensDiameter / 2,
      image: element.toDataURL('image/png'),
      backgroundSize: `${imageBounds.width * magnification}px ${imageBounds.height * magnification}px`,
      backgroundPosition: `${lensDiameter / 2 - x * magnification}px ${lensDiameter / 2 - y * magnification}px`,
    });
  };

  const beginPan = (event: PointerEvent<HTMLDivElement>) => {
    if (busy) return;
    if (tool !== 'pan' && !spaceDownRef.current && event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
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
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      ref={workspaceRef as RefObject<HTMLDivElement>}
      data-image-editor-workspace
      aria-busy={busy}
      className="relative min-h-0 flex-1 overflow-hidden bg-echo-surface touch-none"
      onPointerDownCapture={beginPan}
      onPointerMoveCapture={movePan}
      onPointerMove={updateLens}
      onPointerUpCapture={endPan}
      onPointerCancelCapture={endPan}
      onPointerLeave={() => setLens(null)}
      onWheelCapture={(event) => {
        if (busy) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        onZoom(
          { x: event.clientX - rect.left, y: event.clientY - rect.top },
          view.scale * (event.deltaY > 0 ? 0.9 : 1.1),
        );
      }}
    >
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
      {lens ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-20 size-36 rounded-full border-2 border-echo-border bg-echo-surface shadow-echo-lg"
          style={{
            left: lens.left,
            top: lens.top,
            backgroundImage: `url(${lens.image})`,
            backgroundSize: lens.backgroundSize,
            backgroundPosition: lens.backgroundPosition,
          }}
        />
      ) : null}
    </div>
  );
}
