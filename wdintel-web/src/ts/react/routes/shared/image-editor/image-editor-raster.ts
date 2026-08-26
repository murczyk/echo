import type { ConcealMode } from './image-editor.types';

type FabricModule = typeof import('fabric');
type RasterSource = { element: CanvasImageSource; width: number; height: number };

function nativeBounds({
  sourceImage,
  bounds,
}: {
  sourceImage: import('fabric').FabricImage;
  bounds: { left: number; top: number; width: number; height: number };
}) {
  const imageWidth = sourceImage.width ?? 0;
  const imageHeight = sourceImage.height ?? 0;
  const left = Math.max(0, Math.floor(bounds.left));
  const top = Math.max(0, Math.floor(bounds.top));
  const right = Math.min(imageWidth, Math.ceil(bounds.left + bounds.width));
  const bottom = Math.min(imageHeight, Math.ceil(bounds.top + bounds.height));
  return { left, top, width: right - left, height: bottom - top };
}

function sourceElement(sourceImage: import('fabric').FabricImage) {
  const element = sourceImage.getElement();
  if (!element) throw new Error('Не вдалося обробити виділену область');
  return element;
}

export function buildSafeRaster({
  canvas,
  sourceImage,
}: {
  canvas: import('fabric').Canvas;
  sourceImage: import('fabric').FabricImage;
}) {
  const element = sourceElement(sourceImage);
  const width = sourceImage.width ?? 0;
  const height = sourceImage.height ?? 0;
  const elementWidth =
    Number((element as { naturalWidth?: number; width?: number }).naturalWidth) ||
    Number((element as { width?: number }).width) ||
    width;
  const elementHeight =
    Number((element as { naturalHeight?: number; height?: number }).naturalHeight) ||
    Number((element as { height?: number }).height) ||
    height;
  const cropX = Math.max(0, Math.min(Number(sourceImage.get?.('cropX') ?? 0), elementWidth));
  const cropY = Math.max(0, Math.min(Number(sourceImage.get?.('cropY') ?? 0), elementHeight));
  const sourceWidth = Math.max(0, Math.min(width, elementWidth - cropX));
  const sourceHeight = Math.max(0, Math.min(height, elementHeight - cropY));
  const safe = document.createElement('canvas');
  safe.width = width;
  safe.height = height;
  const context = safe.getContext('2d');
  if (!context) throw new Error('Не вдалося підготувати безпечне зображення');
  context.drawImage(element, cropX, cropY, sourceWidth, sourceHeight, 0, 0, width, height);
  canvas.getObjects().forEach((object) => {
    if (object.get('editorRole') !== 'concealment') return;
    const left = object.left ?? 0;
    const top = object.top ?? 0;
    const width = (object.width ?? 0) * (object.scaleX ?? 1);
    const height = (object.height ?? 0) * (object.scaleY ?? 1);
    if (object.type === 'rect' || object.type === 'Rect') {
      context.fillStyle = typeof object.fill === 'string' ? object.fill : '#1f2937';
      context.fillRect(left, top, width, height);
      return;
    }
    const element = (object as import('fabric').FabricImage).getElement?.();
    if (element) context.drawImage(element, left, top, width, height);
  });
  return { element: safe, width: safe.width, height: safe.height } satisfies RasterSource;
}

async function blurredPatch({
  source,
  bounds,
}: {
  source: RasterSource;
  bounds: { left: number; top: number; width: number; height: number };
}) {
  const patch = document.createElement('canvas');
  patch.width = bounds.width;
  patch.height = bounds.height;
  const context = patch.getContext('2d');
  if (!context) throw new Error('Не вдалося розмити виділену область');
  const bleed = 16;
  const imageWidth = source.width;
  const imageHeight = source.height;
  const expandedLeft = Math.max(0, bounds.left - bleed);
  const expandedTop = Math.max(0, bounds.top - bleed);
  const expandedRight = Math.min(imageWidth, bounds.left + bounds.width + bleed);
  const expandedBottom = Math.min(imageHeight, bounds.top + bounds.height + bleed);
  const expandedWidth = expandedRight - expandedLeft;
  const expandedHeight = expandedBottom - expandedTop;
  const expanded = document.createElement('canvas');
  expanded.width = expandedWidth;
  expanded.height = expandedHeight;
  const expandedContext = expanded.getContext('2d');
  if (!expandedContext) throw new Error('Не вдалося розмити виділену область');
  expandedContext.filter = 'blur(18px)';
  expandedContext.drawImage(
    source.element,
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
    bounds.left - expandedLeft,
    bounds.top - expandedTop,
    bounds.width,
    bounds.height,
    0,
    0,
    bounds.width,
    bounds.height,
  );
  return patch;
}

async function pixelatedPatch({
  source,
  bounds,
}: {
  source: RasterSource;
  bounds: { left: number; top: number; width: number; height: number };
}) {
  const patch = document.createElement('canvas');
  patch.width = bounds.width;
  patch.height = bounds.height;
  const context = patch.getContext('2d');
  if (!context) throw new Error('Не вдалося пікселізувати виділену область');
  const reduced = document.createElement('canvas');
  reduced.width = Math.max(1, Math.ceil(bounds.width / 12));
  reduced.height = Math.max(1, Math.ceil(bounds.height / 12));
  const reducedContext = reduced.getContext('2d');
  if (!reducedContext) throw new Error('Не вдалося пікселізувати виділену область');
  reducedContext.drawImage(
    source.element,
    bounds.left,
    bounds.top,
    bounds.width,
    bounds.height,
    0,
    0,
    reduced.width,
    reduced.height,
  );
  context.imageSmoothingEnabled = false;
  context.drawImage(
    reduced,
    0,
    0,
    reduced.width,
    reduced.height,
    0,
    0,
    bounds.width,
    bounds.height,
  );
  return patch;
}

export async function replaceConcealmentArea({
  canvas,
  sourceImage,
  fabric,
  bounds: requestedBounds,
  mode,
}: {
  canvas: import('fabric').Canvas;
  sourceImage: import('fabric').FabricImage;
  fabric: FabricModule;
  bounds: { left: number; top: number; width: number; height: number };
  mode: ConcealMode;
}) {
  const bounds = nativeBounds({ sourceImage, bounds: requestedBounds });
  const safe = buildSafeRaster({ canvas, sourceImage });
  if (bounds.width < 3 || bounds.height < 3) {
    canvas.requestRenderAll();
    return false;
  }
  const replacement =
    mode === 'redact'
      ? new fabric.Rect({
          ...bounds,
          fill: '#1f2937',
          editorRole: 'concealment',
          selectable: false,
          evented: false,
        })
      : new fabric.FabricImage(
          await (mode === 'blur'
            ? blurredPatch({ source: safe, bounds })
            : pixelatedPatch({ source: safe, bounds })),
        );
  replacement.set({
    ...bounds,
    editorRole: 'concealment',
    objectCaching: false,
    selectable: false,
    evented: false,
  });
  canvas.add(replacement);
  canvas.discardActiveObject();
  canvas.requestRenderAll();
  return true;
}

export const replaceConcealmentDraft = async ({
  draft,
  ...args
}: Omit<Parameters<typeof replaceConcealmentArea>[0], 'bounds'> & {
  draft: import('fabric').FabricObject;
}) => replaceConcealmentArea({ ...args, bounds: draft.getBoundingRect() });
