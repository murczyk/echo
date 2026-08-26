import type { MutableRefObject } from 'react';

import type { ImageEditorDocumentSnapshot } from './image-editor-document-snapshot';
import { assignImageEditorTextareaContainers } from './image-editor-text';

export function setImageEditorBackground({
  canvas,
  source,
}: {
  canvas: import('fabric').Canvas;
  source: import('fabric').FabricImage;
}) {
  source.set({
    left: 0,
    top: 0,
    originX: 'left',
    originY: 'top',
    scaleX: 1,
    scaleY: 1,
    angle: 0,
  });
  canvas.backgroundImage = source;
  canvas.requestRenderAll();
}

export function restoreImageEditorCanvasReferences({
  canvas,
  sourceRef,
  cropRef,
  snapshot,
  hiddenTextareaContainer,
}: {
  canvas: import('fabric').Canvas;
  sourceRef: MutableRefObject<import('fabric').FabricImage | null>;
  cropRef: MutableRefObject<import('fabric').Rect | null>;
  snapshot?: ImageEditorDocumentSnapshot;
  hiddenTextareaContainer?: HTMLElement | null;
}) {
  canvas.getObjects().forEach((object) => {
    const children = (object as import('fabric').Group).getObjects?.();
    if (
      children?.some((child) => child.type === 'line' || child.type === 'Line') &&
      children.some((child) => child.type === 'triangle' || child.type === 'Triangle')
    )
      object.set({ editorRole: 'arrow', selectable: true, evented: true });
  });
  const source = canvas.backgroundImage as import('fabric').FabricImage | undefined;
  if (source) {
    const background = snapshot?.background;
    if (background) {
      source.set(background);
      canvas.backgroundImage = source;
    } else setImageEditorBackground({ canvas, source });
    sourceRef.current = source;
  }
  if (snapshot) canvas.setDimensions({ width: snapshot.width, height: snapshot.height });
  cropRef.current = null;
  if (hiddenTextareaContainer) assignImageEditorTextareaContainers(canvas, hiddenTextareaContainer);
  canvas.discardActiveObject();
  canvas.requestRenderAll();
}
