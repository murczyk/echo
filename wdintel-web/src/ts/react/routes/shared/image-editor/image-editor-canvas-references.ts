import type { MutableRefObject } from 'react';

import type { ImageEditorDocumentSnapshot } from './image-editor-document-snapshot';
import { ImageEditorObjectRole } from './image-editor.types';
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
  const legacyTexts = new Map<string, import('fabric').FabricObject>();
  canvas.getObjects().forEach((object) => {
    if (typeof object.get !== 'function') return;
    const id = object.get('imageEditorTextId');
    if (typeof id === 'string') legacyTexts.set(id, object);
  });
  canvas
    .getObjects()
    .slice()
    .forEach((object) => {
      if (typeof object.get !== 'function') return;
      const ownerId = object.get('attachedTextId');
      const owner = typeof ownerId === 'string' ? legacyTexts.get(ownerId) : undefined;
      if (!owner) return;
      const x = Number(object.get('attachedArrowTargetX'));
      const y = Number(object.get('attachedArrowTargetY'));
      if (Number.isFinite(x) && Number.isFinite(y))
        owner.set({ attachedArrowTargetX: x, attachedArrowTargetY: y });
      canvas.remove(object);
    });
  canvas.getObjects().forEach((object) => {
    const children = (object as import('fabric').Group).getObjects?.();
    if (
      children?.some((child) => child.type === 'line' || child.type === 'Line') &&
      children.some((child) => child.type === 'triangle' || child.type === 'Triangle')
    )
      object.set({
        editorRole: ImageEditorObjectRole.Arrow,
        selectable: object.get('attachedTextId') == null,
        evented: object.get('attachedTextId') == null,
      });
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
