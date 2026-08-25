import type { MutableRefObject } from 'react';

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
}: {
  canvas: import('fabric').Canvas;
  sourceRef: MutableRefObject<import('fabric').FabricImage | null>;
  cropRef: MutableRefObject<import('fabric').Rect | null>;
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
    setImageEditorBackground({ canvas, source });
    sourceRef.current = source;
  }
  cropRef.current = canvas
    .getObjects()
    .find((object) => object.get('editorRole') === 'crop') as import('fabric').Rect;
}
