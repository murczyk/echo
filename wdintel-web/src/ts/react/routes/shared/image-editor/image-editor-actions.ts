type FabricModule = typeof import('fabric');

export function addTextAnnotation({
  canvas,
  fabric,
  stroke,
  fontSize,
  bold,
  left,
  top,
}: {
  canvas: import('fabric').Canvas;
  fabric: FabricModule;
  stroke: string;
  fontSize: number;
  bold: boolean;
  left: number;
  top: number;
}) {
  const text = new fabric.IText('', {
    left,
    top,
    fill: stroke,
    fontSize,
    fontWeight: bold ? 'bold' : 'normal',
    editorRole: 'text',
  });
  canvas.add(text);
  canvas.setActiveObject(text);
  text.enterEditing();
  text.selectAll();
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
