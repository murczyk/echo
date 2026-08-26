import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import {
  clampEditorPan,
  clampEditorScale,
  centerEditorView,
  fitEditorScale,
  resizeEditorView,
  zoomEditorAtPoint,
  type EditorSize,
  type EditorViewState,
} from './image-editor-viewport';

type Canvas = import('fabric').Canvas;

const INITIAL_VIEW: EditorViewState = { scale: 1, pan: { x: 0, y: 0 }, mode: 'fit' };

function sizeOf(element: HTMLElement): EditorSize {
  return { width: element.clientWidth, height: element.clientHeight };
}

export function useImageEditorViewport({
  canvasRef,
  workspaceRef,
  canvasReady,
}: {
  canvasRef: RefObject<Canvas | null>;
  workspaceRef: RefObject<HTMLDivElement | null>;
  canvasReady: boolean;
}) {
  const [view, setView] = useState(INITIAL_VIEW);
  const viewRef = useRef(view);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return;
    canvas.setDimensions(
      { width: canvas.width * view.scale, height: canvas.height * view.scale },
      { cssOnly: true },
    );
    canvas.calcOffset();
  }, [canvasRef, view.scale]);

  const getSizes = useCallback(() => {
    const canvas = canvasRef.current;
    const workspace = workspaceRef.current;
    if (!canvas || !workspace || canvas.width <= 0 || canvas.height <= 0) return null;
    return {
      document: { width: canvas.width, height: canvas.height },
      workspace: sizeOf(workspace),
    };
  }, [canvasRef, workspaceRef]);

  const fitViewport = useCallback(() => {
    const sizes = getSizes();
    if (!sizes || sizes.workspace.width === 0 || sizes.workspace.height === 0) return;
    setView({
      scale: fitEditorScale(sizes.document, sizes.workspace),
      pan: { x: 0, y: 0 },
      mode: 'fit',
    });
    setReady(true);
  }, [getSizes]);

  const actualSize = useCallback(() => {
    setView({ scale: 1, pan: { x: 0, y: 0 }, mode: 'actual' });
    setReady(true);
  }, []);
  const centerViewport = useCallback(() => setView((current) => centerEditorView(current)), []);

  const setViewportZoom = useCallback(
    (scale: number) => {
      const sizes = getSizes();
      if (!sizes) return;
      setView((current) =>
        zoomEditorAtPoint({
          view: current,
          ...sizes,
          point: { x: sizes.workspace.width / 2, y: sizes.workspace.height / 2 },
          scale,
        }),
      );
    },
    [getSizes],
  );

  const zoomAtPoint = useCallback(
    (point: { x: number; y: number }, scale: number) => {
      const sizes = getSizes();
      if (!sizes) return;
      setView((current) => zoomEditorAtPoint({ view: current, ...sizes, point, scale }));
    },
    [getSizes],
  );

  const panBy = useCallback(
    (delta: { x: number; y: number }) => {
      const sizes = getSizes();
      if (!sizes) return;
      setView((current) => ({
        ...current,
        pan: clampEditorPan(
          { x: current.pan.x + delta.x, y: current.pan.y + delta.y },
          sizes.document,
          sizes.workspace,
          current.scale,
        ),
        mode: 'custom',
      }));
    },
    [getSizes],
  );

  useEffect(() => {
    if (!canvasReady) return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const sync = () => {
      const sizes = getSizes();
      if (!sizes || sizes.workspace.width === 0 || sizes.workspace.height === 0) return;
      setView((current) => resizeEditorView(current, sizes.document, sizes.workspace));
      setReady(true);
    };
    const frame = requestAnimationFrame(sync);
    const observer = new ResizeObserver(sync);
    observer.observe(workspace);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [canvasReady, getSizes, workspaceRef]);

  return {
    actualSize,
    centerViewport,
    fitViewport,
    panBy,
    ready,
    setViewportZoom,
    view,
    zoomAtPoint,
    zoom: Math.round(clampEditorScale(view.scale) * 100),
  };
}
