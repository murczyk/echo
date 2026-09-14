import { ImageEditorObjectRole, ImageEditorTool } from './image-editor.types';
import { withHighlightAlpha } from './image-editor-selection-style';

const CREATION_TOOLS = new Set<ImageEditorTool>([
  ImageEditorTool.Text,
  ImageEditorTool.Crop,
  ImageEditorTool.Rectangle,
  ImageEditorTool.Ellipse,
  ImageEditorTool.Line,
  ImageEditorTool.Arrow,
  ImageEditorTool.Brush,
  ImageEditorTool.Conceal,
  ImageEditorTool.Magnifier,
]);

const CURSOR_BY_TOOL = {
  [ImageEditorTool.Select]: 'default',
  [ImageEditorTool.Pan]: 'grab',
  [ImageEditorTool.Crop]: 'crosshair',
  [ImageEditorTool.Text]: 'text',
  [ImageEditorTool.Rectangle]: 'crosshair',
  [ImageEditorTool.Ellipse]: 'crosshair',
  [ImageEditorTool.Line]: 'crosshair',
  [ImageEditorTool.Arrow]: 'crosshair',
  [ImageEditorTool.Brush]: 'crosshair',
  [ImageEditorTool.Conceal]: 'crosshair',
  [ImageEditorTool.Magnifier]: 'zoom-in',
} satisfies Record<ImageEditorTool, CSSStyleDeclaration['cursor']>;

export function imageEditorCursor(tool: ImageEditorTool) {
  return CURSOR_BY_TOOL[tool];
}

export function applyImageEditorSurfaceCursor(
  canvas: import('fabric').Canvas | null,
  cursor: string,
) {
  if (canvas) canvas.upperCanvasEl.style.cursor = cursor;
}

export function updateImageEditorBrushStyle({
  canvas,
  stroke,
  strokeWidth,
  highlightOpacity,
}: {
  canvas: import('fabric').Canvas | null;
  stroke: string;
  strokeWidth: number;
  highlightOpacity: number;
}) {
  if (!canvas?.isDrawingMode || !canvas.freeDrawingBrush) return;
  canvas.freeDrawingBrush.color = withHighlightAlpha(stroke, highlightOpacity);
  canvas.freeDrawingBrush.width = strokeWidth;
}

export function applyImageEditorInteractionMode({
  canvas,
  tool,
  fabric,
  stroke,
  strokeWidth,
  highlightOpacity,
}: {
  canvas: import('fabric').Canvas;
  tool: ImageEditorTool;
  fabric?: typeof import('fabric') | null;
  stroke?: string;
  strokeWidth?: number;
  highlightOpacity?: number;
}) {
  const selecting = tool === ImageEditorTool.Select || tool === ImageEditorTool.Crop;
  const textSelecting = tool === ImageEditorTool.Text;
  const creationTool = CREATION_TOOLS.has(tool);
  const activeObject = canvas.getActiveObject();
  const preserveTextEditing =
    tool === ImageEditorTool.Text &&
    (activeObject as import('fabric').IText | undefined)?.isEditing === true;
  if (
    !preserveTextEditing &&
    activeObject &&
    'exitEditing' in activeObject &&
    typeof activeObject.exitEditing === 'function'
  )
    activeObject.exitEditing();
  if (!preserveTextEditing) canvas.discardActiveObject();
  canvas.selection = selecting || textSelecting;
  canvas.skipTargetFind = !(selecting || textSelecting);
  canvas.isDrawingMode = tool === ImageEditorTool.Brush;
  if (canvas.isDrawingMode && fabric && stroke != null && strokeWidth != null) {
    const brush = new fabric.PencilBrush(canvas);
    brush.color = withHighlightAlpha(stroke, highlightOpacity);
    brush.width = strokeWidth;
    canvas.freeDrawingBrush = brush;
  }
  canvas.defaultCursor = imageEditorCursor(tool);
  canvas.freeDrawingCursor = imageEditorCursor(tool);
  canvas.getObjects().forEach((object) => {
    const role = object.get('editorRole');
    if (
      role === ImageEditorObjectRole.Concealment ||
      role === ImageEditorObjectRole.CropMask ||
      role === ImageEditorObjectRole.DerivedArrow
    ) {
      object.set({ selectable: false, evented: false });
      return;
    }
    const editable =
      ((tool === ImageEditorTool.Select || tool === ImageEditorTool.Text) &&
        role !== ImageEditorObjectRole.Crop &&
        (tool !== ImageEditorTool.Text || role === ImageEditorObjectRole.Text)) ||
      (tool === ImageEditorTool.Crop && role === ImageEditorObjectRole.Crop);
    object.set({ selectable: editable, evented: editable });
  });
  if (creationTool || tool === ImageEditorTool.Pan || selecting) canvas.requestRenderAll();
}
