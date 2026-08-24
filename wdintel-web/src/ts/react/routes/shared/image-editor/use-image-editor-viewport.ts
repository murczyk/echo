import { useCallback, useEffect, useState, type RefObject } from 'react';

type Canvas = import('fabric').Canvas;

export function useImageEditorViewport({
  canvasRef,
  viewportRef,
  canvasReady,
}: {
  canvasRef: RefObject<Canvas | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
  canvasReady: boolean;
}) {
  const [zoom, setZoom] = useState(100);
  const [cssScale, setCssScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const setCanvasCssSize = useCallback(
    (scale: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.setDimensions(
        { width: Math.max(1, canvas.width * scale), height: Math.max(1, canvas.height * scale) },
        { cssOnly: true },
      );
      setCssScale(scale);
    },
    [canvasRef],
  );

  const fitViewport = useCallback(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport || canvas.width <= 0 || canvas.height <= 0) return;
    const scale = Math.min(
      1,
      Math.max(0.1, (viewport.clientWidth - 24) / canvas.width),
      Math.max(0.1, (viewport.clientHeight - 24) / canvas.height),
    );
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    setCanvasCssSize(scale);
    setPan({ x: 0, y: 0 });
    setZoom(Math.round(scale * 100));
  }, [canvasRef, setCanvasCssSize, viewportRef]);

  const setViewportZoom = useCallback(
    (next: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const zoomValue = Math.max(0.1, Math.min(8, next / cssScale));
      canvas.setZoom(zoomValue);
      setZoom(Math.round(zoomValue * cssScale * 100));
    },
    [canvasRef, cssScale],
  );

  const actualSize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    setCanvasCssSize(1);
    setPan({ x: 0, y: 0 });
    setZoom(100);
  }, [canvasRef, setCanvasCssSize]);

  const resetViewport = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    setPan({ x: 0, y: 0 });
    setZoom(Math.round(cssScale * 100));
  }, [canvasRef, cssScale]);

  useEffect(() => {
    if (!canvasReady) return;
    const frame = requestAnimationFrame(fitViewport);
    const observer = new ResizeObserver(fitViewport);
    if (viewportRef.current) observer.observe(viewportRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [canvasReady, fitViewport, viewportRef]);

  return { actualSize, cssScale, fitViewport, pan, resetViewport, setPan, setViewportZoom, zoom };
}
