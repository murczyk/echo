import { useEffect, type MutableRefObject } from 'react';

import { ImageEditorTool } from './image-editor.types';

export function useImageEditorPan({
  canvasRef,
  fabricRef,
  cssScale,
  tool,
  setPan,
  setViewportZoom,
}: {
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  fabricRef: MutableRefObject<typeof import('fabric') | null>;
  cssScale: number;
  tool: ImageEditorTool;
  setPan: (value: { x: number; y: number }) => void;
  setViewportZoom: (value: number) => void;
}) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let dragging = false;
    let last = { x: 0, y: 0 };
    const down = (event: { e: MouseEvent }) => {
      if (tool !== ImageEditorTool.Pan && !(event.e.button === 2 || event.e.shiftKey)) return;
      dragging = true;
      last = { x: event.e.clientX, y: event.e.clientY };
      canvas.defaultCursor = 'grabbing';
    };
    const move = (event: { e: MouseEvent }) => {
      if (!dragging || !canvas.viewportTransform) return;
      const transform = canvas.viewportTransform;
      transform[4] += event.e.clientX - last.x;
      transform[5] += event.e.clientY - last.y;
      last = { x: event.e.clientX, y: event.e.clientY };
      canvas.setViewportTransform(transform);
      setPan({ x: transform[4], y: transform[5] });
    };
    const up = () => {
      dragging = false;
      canvas.defaultCursor = tool === ImageEditorTool.Pan ? 'grab' : 'default';
    };
    const wheel = (event: { e: WheelEvent }) => {
      event.e.preventDefault();
      const next = Math.max(0.1, Math.min(8, canvas.getZoom() * (event.e.deltaY > 0 ? 0.9 : 1.1)));
      canvas.zoomToPoint(new fabricRef.current!.Point(event.e.offsetX, event.e.offsetY), next);
      setViewportZoom(next * cssScale);
    };
    const suppressContextMenu = (event: Event) => event.preventDefault();
    canvas.on('mouse:down', down as never);
    canvas.on('mouse:move', move as never);
    canvas.on('mouse:up', up as never);
    canvas.on('mouse:wheel', wheel as never);
    canvas.upperCanvasEl.addEventListener('contextmenu', suppressContextMenu);
    return () => {
      canvas.off('mouse:down', down as never);
      canvas.off('mouse:move', move as never);
      canvas.off('mouse:up', up as never);
      canvas.off('mouse:wheel', wheel as never);
      canvas.upperCanvasEl.removeEventListener('contextmenu', suppressContextMenu);
    };
  }, [canvasRef, cssScale, fabricRef, setPan, setViewportZoom, tool]);
}
