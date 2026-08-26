import { useEffect, type MutableRefObject, type RefObject } from 'react';

import { setImageEditorBackground } from './image-editor-canvas-references';
import type { ImageEditorSource, ImageEditorTool } from './image-editor.types';

const MAX_PIXELS = 24_000_000;
const MAX_SIDE = 8_192;

export function finalizeImageEditorText(
  canvas: import('fabric').Canvas,
  text: import('fabric').IText | undefined,
  saveHistory: () => void,
) {
  if (!text) return false;
  if (text.text?.trim()) {
    saveHistory();
    return true;
  }
  canvas.remove(text);
  canvas.requestRenderAll();
  return false;
}

async function isAnimatedWebp(source: ImageEditorSource) {
  if (source.mimeType !== 'image/webp') return false;
  const header = new Uint8Array(await source.blob.slice(0, 128 * 1024).arrayBuffer());
  if (String.fromCharCode(...header.slice(0, 4)) !== 'RIFF') return false;
  for (let index = 12; index + 8 <= header.length;) {
    if (String.fromCharCode(...header.slice(index, index + 4)) === 'ANIM') return true;
    const size =
      header[index + 4] |
      (header[index + 5] << 8) |
      (header[index + 6] << 16) |
      (header[index + 7] << 24);
    index += 8 + (size >>> 0) + ((size >>> 0) % 2);
  }
  return false;
}

export function useImageEditorCanvas({
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
  onDocumentResized,
}: {
  source: ImageEditorSource;
  canvasElementRef: RefObject<HTMLCanvasElement | null>;
  fabricRef: MutableRefObject<typeof import('fabric') | null>;
  canvasRef: MutableRefObject<import('fabric').Canvas | null>;
  sourceRef: MutableRefObject<import('fabric').FabricImage | null>;
  cropRef: MutableRefObject<import('fabric').Rect | null>;
  saveHistory: () => void;
  clearHistory: () => void;
  setCanvasReady: (ready: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string) => void;
  toolRef: MutableRefObject<ImageEditorTool>;
  onDocumentResized: () => void;
}) {
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    const init = async () => {
      try {
        const fabric = await import('fabric');
        if (disposed || !canvasElementRef.current) return;
        if (await isAnimatedWebp(source))
          throw new Error('Анімовані WebP-зображення доступні лише для перегляду');
        if (disposed || !canvasElementRef.current) return;
        fabricRef.current = fabric;
        objectUrl = URL.createObjectURL(source.blob);
        const image = await fabric.FabricImage.fromURL(objectUrl);
        if (disposed) return;
        if (
          image.width == null ||
          image.height == null ||
          image.width > MAX_SIDE ||
          image.height > MAX_SIDE ||
          image.width * image.height > MAX_PIXELS
        )
          throw new Error(
            'Зображення завелике для редагування у браузері. Його все ще можна переглянути або завантажити.',
          );
        const canvas = new fabric.Canvas(canvasElementRef.current, {
          enableRetinaScaling: false,
          preserveObjectStacking: true,
          selection: true,
        });
        canvas.setDimensions({ width: image.width, height: image.height });
        setImageEditorBackground({ canvas, source: image });
        canvasRef.current = canvas;
        sourceRef.current = image;
        const commit = (event?: { target?: import('fabric').FabricObject }) => {
          const role = event?.target?.get('editorRole');
          if (role === 'crop' || role === 'crop-mask') return;
          saveHistory();
        };
        canvas.on('object:modified', commit);
        canvas.on('path:created', (event) => {
          const role =
            toolRef.current === 'brush' || toolRef.current === 'highlight'
              ? toolRef.current
              : undefined;
          if (role && event.path)
            event.path.set({ editorRole: role, selectable: false, evented: false });
          commit();
        });
        const commitText = (event: { target?: import('fabric').FabricObject }) => {
          const text = event.target as import('fabric').IText | undefined;
          finalizeImageEditorText(canvas, text, () => commit(event));
        };
        canvas.on('text:editing:exited', commitText);
        saveHistory();
        onDocumentResized();
        setCanvasReady(true);
        setLoading(false);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : 'Не вдалося відкрити зображення для редагування',
        );
        setLoading(false);
      }
    };
    void init();
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      canvasRef.current?.dispose();
      canvasRef.current = null;
      sourceRef.current = null;
      cropRef.current = null;
      clearHistory();
      setCanvasReady(false);
    };
  }, [
    canvasElementRef,
    canvasRef,
    clearHistory,
    cropRef,
    fabricRef,
    toolRef,
    saveHistory,
    setCanvasReady,
    setError,
    setLoading,
    source,
    sourceRef,
    onDocumentResized,
  ]);
}
