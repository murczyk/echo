export function restoreImageEditorCanvasReferences({
  canvas,
  sourceRef,
  cropRef,
}: {
  canvas: import('fabric').Canvas;
  sourceRef: MutableRefObject<import('fabric').FabricImage | null>;
  cropRef: MutableRefObject<import('fabric').Rect | null>;
}) {
  sourceRef.current = canvas
    .getObjects()
    .find((object) => object.get('editorRole') === 'source') as import('fabric').FabricImage;
  cropRef.current = canvas
    .getObjects()
    .find((object) => object.get('editorRole') === 'crop') as import('fabric').Rect;
}
import type { MutableRefObject } from 'react';
