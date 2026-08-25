import { CircularProgress } from '@mui/material';
import { useEffect, useRef, type PointerEvent, type RefObject } from 'react';

import type { EditorViewState } from './image-editor-viewport';
import type { ImageEditorTool } from './image-editor.types';

export function ImageEditorWorkspace({
  canvasElementRef,
  workspaceRef,
  tool,
  view,
  ready,
  loading,
  onPan,
  onZoom,
}: {
  canvasElementRef: RefObject<HTMLCanvasElement | null>;
  workspaceRef: RefObject<HTMLDivElement | null>;
  tool: ImageEditorTool;
  view: EditorViewState;
  ready: boolean;
  loading: boolean;
  onPan: (delta: { x: number; y: number }) => void;
  onZoom: (point: { x: number; y: number }, scale: number) => void;
}) {
  const dragRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const spaceDownRef = useRef(false);
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

  const beginPan = (event: PointerEvent<HTMLDivElement>) => {
    if (tool !== 'pan' && !spaceDownRef.current && event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
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
      className="relative min-h-0 flex-1 overflow-hidden bg-echo-surface touch-none"
      onPointerDownCapture={beginPan}
      onPointerMoveCapture={movePan}
      onPointerUpCapture={endPan}
      onPointerCancelCapture={endPan}
      onWheelCapture={(event) => {
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
          transform: `translate(calc(-50% + ${view.pan.x}px), calc(-50% + ${view.pan.y}px)) scale(${view.scale})`,
          visibility: ready && !loading ? 'visible' : 'hidden',
        }}
      >
        <canvas ref={canvasElementRef as RefObject<HTMLCanvasElement>} />
      </div>
    </div>
  );
}
