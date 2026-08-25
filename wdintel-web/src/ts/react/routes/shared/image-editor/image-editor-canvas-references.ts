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
  if (source) sourceRef.current = source;
  cropRef.current = canvas
    .getObjects()
    .find((object) => object.get('editorRole') === 'crop') as import('fabric').Rect;
}
import type { MutableRefObject } from 'react';
