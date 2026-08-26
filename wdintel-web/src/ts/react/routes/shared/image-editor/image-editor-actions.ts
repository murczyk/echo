type FabricModule = typeof import('fabric');

import { assignImageEditorTextareaContainer } from './image-editor-text';

export function addTextAnnotation({
  canvas,
  fabric,
  stroke,
  fontSize,
  bold,
  left,
  top,
  hiddenTextareaContainer,
}: {
  canvas: import('fabric').Canvas;
  fabric: FabricModule;
  stroke: string;
  fontSize: number;
  bold: boolean;
  left: number;
  top: number;
  hiddenTextareaContainer: HTMLElement | null;
}) {
  const text = new fabric.IText('', {
    left,
    top,
    originX: 'left',
    originY: 'top',
    fill: stroke,
    fontSize,
    fontWeight: bold ? 'bold' : 'normal',
    editorRole: 'text',
  });
  assignImageEditorTextareaContainer(text, hiddenTextareaContainer);
  canvas.add(text);
  return text;
}

export function deleteSelectedAnnotations(canvas: import('fabric').Canvas) {
  const selected = canvas
    .getActiveObjects()
    .filter(
      (object) => !['concealment', 'crop', 'crop-mask'].includes(String(object.get('editorRole'))),
    );
  selected.forEach((object) => canvas.remove(object));
  canvas.discardActiveObject();
  canvas.requestRenderAll();
}
