export function lockImageEditorSource(source: import('fabric').FabricImage) {
  source.set({
    editorRole: 'source',
    selectable: false,
    evented: false,
    hasControls: false,
    hasBorders: false,
    left: 0,
    top: 0,
    originX: 'left',
    originY: 'top',
    scaleX: 1,
    scaleY: 1,
    angle: 0,
    lockMovementX: true,
    lockMovementY: true,
  });
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
  const source = canvas
    .getObjects()
    .find((object) => object.get('editorRole') === 'source') as import('fabric').FabricImage;
  if (source) {
    lockImageEditorSource(source);
    canvas.sendObjectToBack(source);
    sourceRef.current = source;
  }
  cropRef.current = canvas
    .getObjects()
    .find((object) => object.get('editorRole') === 'crop') as import('fabric').Rect;
}
import type { MutableRefObject } from 'react';
