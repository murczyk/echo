import type { ConcealMode } from './image-editor.types';

type FabricModule = typeof import('fabric');

function magnifierId() {
  return `magnifier-${crypto.randomUUID()}`;
}

export function updateMagnifierConnector({
  canvas,
  magnifier,
}: {
  canvas: import('fabric').Canvas;
  magnifier: import('fabric').FabricObject;
}) {
  const id = magnifier.get('magnifierId');
  const sourceX = magnifier.get('magnifierSourceX');
  const sourceY = magnifier.get('magnifierSourceY');
  if (typeof id !== 'string' || typeof sourceX !== 'number' || typeof sourceY !== 'number') return;
  const calloutX = (magnifier.left ?? 0) + 120;
  const calloutY = (magnifier.top ?? 0) + 120;
  const connector = canvas
    .getObjects()
    .find(
      (object) =>
        object.get('editorRole') === 'magnifier-connector' && object.get('magnifierId') === id,
    );
  if (!connector) return;
  connector.set({ x1: sourceX, y1: sourceY, x2: calloutX, y2: calloutY });
  connector.setCoords();
  canvas.requestRenderAll();
}

export async function replaceConcealmentDraft({
  canvas,
  sourceImage,
  fabric,
  draft,
  mode,
}: {
  canvas: import('fabric').Canvas;
  sourceImage: import('fabric').FabricImage;
  fabric: FabricModule;
  draft: import('fabric').FabricObject;
  mode: ConcealMode;
}) {
  const bounds = draft.getBoundingRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const patch = document.createElement('canvas');
  patch.width = width;
  patch.height = height;
  const context = patch.getContext('2d');
  const element = sourceImage.getElement();
  if (!context || !element) throw new Error('Не вдалося обробити виділену область');
  const imageWidth = sourceImage.width ?? 0;
  const imageHeight = sourceImage.height ?? 0;
  const selectedLeft = Math.max(0, Math.round(bounds.left));
  const selectedTop = Math.max(0, Math.round(bounds.top));
  const selectedWidth = Math.min(width, imageWidth - selectedLeft);
  const selectedHeight = Math.min(height, imageHeight - selectedTop);
  if (selectedWidth <= 0 || selectedHeight <= 0)
    throw new Error('Виділена область виходить за межі зображення');
  if (mode === 'pixelate') {
    const cellSize = 12;
    const reduced = document.createElement('canvas');
    reduced.width = Math.max(1, Math.ceil(width / cellSize));
    reduced.height = Math.max(1, Math.ceil(height / cellSize));
    const reducedContext = reduced.getContext('2d');
    if (!reducedContext) throw new Error('Не вдалося пікселізувати виділену область');
    reducedContext.drawImage(
      element,
      selectedLeft,
      selectedTop,
      selectedWidth,
      selectedHeight,
      0,
      0,
      reduced.width,
      reduced.height,
    );
    context.imageSmoothingEnabled = false;
    context.drawImage(reduced, 0, 0, reduced.width, reduced.height, 0, 0, width, height);
  } else {
    const bleed = 16;
    const expandedLeft = Math.max(0, selectedLeft - bleed);
    const expandedTop = Math.max(0, selectedTop - bleed);
    const expandedRight = Math.min(imageWidth, selectedLeft + selectedWidth + bleed);
    const expandedBottom = Math.min(imageHeight, selectedTop + selectedHeight + bleed);
    const expandedWidth = expandedRight - expandedLeft;
    const expandedHeight = expandedBottom - expandedTop;
    const expanded = document.createElement('canvas');
    expanded.width = expandedWidth;
    expanded.height = expandedHeight;
    const expandedContext = expanded.getContext('2d');
    if (!expandedContext) throw new Error('Не вдалося розмити виділену область');
    expandedContext.filter = 'blur(18px)';
    expandedContext.drawImage(
      element,
      expandedLeft,
      expandedTop,
      expandedWidth,
      expandedHeight,
      0,
      0,
      expandedWidth,
      expandedHeight,
    );
    context.drawImage(
      expanded,
      selectedLeft - expandedLeft,
      selectedTop - expandedTop,
      selectedWidth,
      selectedHeight,
      0,
      0,
      selectedWidth,
      selectedHeight,
    );
  }
  const replacement = await fabric.FabricImage.fromURL(patch.toDataURL('image/png'));
  replacement.set({
    left: selectedLeft,
    top: selectedTop,
    editorRole: 'concealment',
    objectCaching: false,
    selectable: false,
    evented: false,
  });
  canvas.remove(draft);
  canvas.add(replacement);
  canvas.setActiveObject(replacement);
  canvas.requestRenderAll();
}

export async function addMagnifier({
  canvas,
  sourceImage,
  fabric,
  magnification,
  stroke,
  strokeWidth,
  sourcePoint,
  calloutPoint,
}: {
  canvas: import('fabric').Canvas;
  sourceImage: import('fabric').FabricImage;
  fabric: FabricModule;
  magnification: number;
  stroke: string;
  strokeWidth: number;
  sourcePoint: { x: number; y: number };
  calloutPoint: { x: number; y: number };
}) {
  const radius = 120;
  const sampleSize = Math.max(1, Math.round((radius * 2) / magnification));
  const sampleLeft = Math.max(
    0,
    Math.min((sourceImage.width ?? 0) - sampleSize, Math.round(sourcePoint.x - sampleSize / 2)),
  );
  const sampleTop = Math.max(
    0,
    Math.min((sourceImage.height ?? 0) - sampleSize, Math.round(sourcePoint.y - sampleSize / 2)),
  );
  const patch = document.createElement('canvas');
  patch.width = radius * 2;
  patch.height = radius * 2;
  const context = patch.getContext('2d');
  const element = sourceImage.getElement();
  if (!context || !element) throw new Error('Не вдалося створити лупу');
  context.beginPath();
  context.arc(radius, radius, radius, 0, Math.PI * 2);
  context.clip();
  context.drawImage(
    element,
    sampleLeft,
    sampleTop,
    sampleSize,
    sampleSize,
    0,
    0,
    radius * 2,
    radius * 2,
  );
  const magnified = await fabric.FabricImage.fromURL(patch.toDataURL('image/png'));
  magnified.set({ left: 0, top: 0, selectable: false, evented: false });
  const border = new fabric.Circle({
    left: 0,
    top: 0,
    radius,
    fill: 'transparent',
    stroke,
    strokeWidth,
    selectable: false,
    evented: false,
  });
  const id = magnifierId();
  const sourceMarker = new fabric.Circle({
    left: sourcePoint.x - 7,
    top: sourcePoint.y - 7,
    radius: 7,
    fill: stroke,
    selectable: false,
    evented: false,
  });
  const connector = new fabric.Line(
    [sourcePoint.x, sourcePoint.y, calloutPoint.x, calloutPoint.y],
    { stroke, strokeWidth: Math.max(1, strokeWidth / 2), selectable: false, evented: false },
  );
  sourceMarker.set('editorRole' as never, 'magnifier-source' as never);
  sourceMarker.set('magnifierId' as never, id as never);
  connector.set('editorRole' as never, 'magnifier-connector' as never);
  connector.set('magnifierId' as never, id as never);
  const group = new fabric.Group([magnified, border], {
    left: calloutPoint.x - radius,
    top: calloutPoint.y - radius,
  });
  group.set('editorRole' as never, 'magnifier' as never);
  group.set('magnifierId' as never, id as never);
  group.set('magnifierSourceX' as never, sourcePoint.x as never);
  group.set('magnifierSourceY' as never, sourcePoint.y as never);
  canvas.add(connector, sourceMarker, group);
  canvas.setActiveObject(group);
  canvas.requestRenderAll();
}
