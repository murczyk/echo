import type { ImageEditorTool } from './image-editor.types';

const CREATION_TOOLS = new Set<ImageEditorTool>([
  'text',
  'crop',
  'rectangle',
  'ellipse',
  'line',
  'arrow',
  'brush',
  'highlight',
  'conceal',
  'magnifier',
]);

export function applyImageEditorInteractionMode({
  canvas,
  tool,
  fabric,
  stroke,
  strokeWidth,
}: {
  canvas: import('fabric').Canvas;
  tool: ImageEditorTool;
  fabric?: typeof import('fabric') | null;
  stroke?: string;
  strokeWidth?: number;
}) {
  const selecting = tool === 'select' || tool === 'crop';
  const creationTool = CREATION_TOOLS.has(tool);
  const activeObject = canvas.getActiveObject();
  if (
    activeObject &&
    'exitEditing' in activeObject &&
    typeof activeObject.exitEditing === 'function'
  )
    activeObject.exitEditing();
  canvas.discardActiveObject();
  canvas.selection = selecting;
  canvas.skipTargetFind = !selecting;
  canvas.isDrawingMode = tool === 'brush' || tool === 'highlight';
  if (canvas.isDrawingMode && fabric && stroke != null && strokeWidth != null) {
    const brush = new fabric.PencilBrush(canvas);
    brush.color = tool === 'highlight' ? `${stroke}66` : stroke;
    brush.width = strokeWidth;
    canvas.freeDrawingBrush = brush;
  }
  canvas.defaultCursor = tool === 'pan' ? 'grab' : 'default';
  canvas.getObjects().forEach((object) => {
    const role = object.get('editorRole');
    if (role === 'concealment' || role === 'crop-mask') return;
    const editable = (tool === 'select' && role !== 'crop') || (tool === 'crop' && role === 'crop');
    object.set({ selectable: editable, evented: editable });
  });
  if (creationTool || tool === 'pan' || selecting) canvas.requestRenderAll();
}
