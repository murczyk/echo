import { ConcealMode, ImageEditorObjectRole } from './image-editor.types';

type FabricModule = typeof import('fabric');
type RasterSource = { element: CanvasImageSource; width: number; height: number };
const MAX_CONCEALMENT_RASTER_PIXELS = 16 * 1024 * 1024;

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
  if (bounds.width < 3 || bounds.height < 3) {
    canvas.requestRenderAll();
    return false;
  }
  if (mode === ConcealMode.Redact) {
    const replacement = new fabric.Rect({
      ...bounds,
      originX: 'left',
      originY: 'top',
      fill: '#1f2937',
      editorRole: ImageEditorObjectRole.Concealment,
      selectable: false,
      evented: false,
    });
    canvas.add(replacement);
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    return true;
  }
  const bleed = mode === ConcealMode.Blur ? 16 : 0;
  const region = {
    left: Math.max(0, bounds.left - bleed),
    top: Math.max(0, bounds.top - bleed),
    width:
      Math.min(sourceImage.width ?? 0, bounds.left + bounds.width + bleed) -
      Math.max(0, bounds.left - bleed),
    height:
      Math.min(sourceImage.height ?? 0, bounds.top + bounds.height + bleed) -
      Math.max(0, bounds.top - bleed),
  };
  const temporaryPixels =
    mode === ConcealMode.Blur
      ? region.width * region.height
      : Math.ceil(bounds.width / 12) * Math.ceil(bounds.height / 12);
  if (
    region.width * region.height + bounds.width * bounds.height + temporaryPixels >
    MAX_CONCEALMENT_RASTER_PIXELS
  )
    throw new Error('Виділена область завелика для безпечної обробки');
  const element = sourceElement(sourceImage);
  const safe = document.createElement('canvas');
  safe.width = region.width;
  safe.height = region.height;
  const context = safe.getContext('2d');
  if (!context) throw new Error('Не вдалося підготувати область зображення');
  const cropX = Number(sourceImage.get?.('cropX') ?? 0);
  const cropY = Number(sourceImage.get?.('cropY') ?? 0);
  context.drawImage(
    element,
    cropX + region.left,
    cropY + region.top,
    region.width,
    region.height,
    0,
    0,
    region.width,
    region.height,
  );
  canvas.getObjects().forEach((object) => {
    if (object.get('editorRole') !== ImageEditorObjectRole.Concealment) return;
    const left = object.left ?? 0,
      top = object.top ?? 0;
    const width = (object.width ?? 0) * (object.scaleX ?? 1),
      height = (object.height ?? 0) * (object.scaleY ?? 1);
    if (
      left + width <= region.left ||
      top + height <= region.top ||
      left >= region.left + region.width ||
      top >= region.top + region.height
    )
      return;
    if (object.type === 'rect' || object.type === 'Rect') {
      context.fillStyle = typeof object.fill === 'string' ? object.fill : '#1f2937';
      context.fillRect(left - region.left, top - region.top, width, height);
    } else {
      const prior = (object as import('fabric').FabricImage).getElement?.();
      if (prior) context.drawImage(prior, left - region.left, top - region.top, width, height);
    }
  });
  const localBounds = {
    left: bounds.left - region.left,
    top: bounds.top - region.top,
    width: bounds.width,
    height: bounds.height,
  };
  const replacement = new fabric.FabricImage(
    await (mode === ConcealMode.Blur
      ? blurredPatch({
          source: { element: safe, width: region.width, height: region.height },
          bounds: localBounds,
        })
      : pixelatedPatch({
          source: { element: safe, width: region.width, height: region.height },
          bounds: localBounds,
        })),
  );
  replacement.set({
    ...bounds,
    originX: 'left',
    originY: 'top',
    editorRole: ImageEditorObjectRole.Concealment,
    objectCaching: false,
    selectable: false,
    evented: false,
  });
  canvas.add(replacement);
  canvas.discardActiveObject();
  canvas.requestRenderAll();
  return true;
}
