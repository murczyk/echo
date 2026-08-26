type Canvas = import('fabric').Canvas;
type Rect = import('fabric').Rect;

const CROP_ROLE = 'crop';
const CROP_MASK_ROLE = 'crop-mask';
const MIN_CROP_SIZE = 8;

function cropBounds(canvas: Canvas, crop: Rect) {
  const bounds = crop.getBoundingRect();
  const left = Math.max(0, Math.min(canvas.width, Math.round(bounds.left)));
  const top = Math.max(0, Math.min(canvas.height, Math.round(bounds.top)));
  const right = Math.max(left, Math.min(canvas.width, Math.round(bounds.left + bounds.width)));
  const bottom = Math.max(top, Math.min(canvas.height, Math.round(bounds.top + bounds.height)));
  return { left, top, width: right - left, height: bottom - top };
}

function removeCropUi(canvas: Canvas) {
  canvas.getObjects().forEach((object) => {
    if ([CROP_ROLE, CROP_MASK_ROLE].includes(String(object.get('editorRole'))))
      canvas.remove(object);
  });
}

function removeCropMasks(canvas: Canvas) {
  canvas.getObjects().forEach((object) => {
    if (object.get('editorRole') === CROP_MASK_ROLE) canvas.remove(object);
  });
}

function addCropMask({
  canvas,
  fabric,
  bounds,
}: {
  canvas: Canvas;
  fabric: typeof import('fabric');
  bounds: ReturnType<typeof cropBounds>;
}) {
  const masks = [
    { left: 0, top: 0, width: canvas.width, height: bounds.top },
    { left: 0, top: bounds.top, width: bounds.left, height: bounds.height },
    {
      left: bounds.left + bounds.width,
      top: bounds.top,
      width: canvas.width - bounds.left - bounds.width,
      height: bounds.height,
    },
    {
      left: 0,
      top: bounds.top + bounds.height,
      width: canvas.width,
      height: canvas.height - bounds.top - bounds.height,
    },
  ];
  masks
    .filter((mask) => mask.width > 0 && mask.height > 0)
    .forEach((mask) => {
      canvas.add(
        new fabric.Rect({
          ...mask,
          fill: 'rgba(0, 0, 0, 0.38)',
          selectable: false,
          evented: false,
          editorRole: CROP_MASK_ROLE,
          excludeFromExport: true,
        }),
      );
    });
}

export function startCrop({
  canvas,
  fabric,
  cropRef,
  stroke,
}: {
  canvas: Canvas;
  fabric: typeof import('fabric');
  cropRef: { current: Rect | null };
  stroke: string;
}) {
  if (cropRef.current) return cropRef.current;
  const inset = Math.min(8, Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 10)));
  const crop = new fabric.Rect({
    left: inset,
    top: inset,
    width: Math.max(MIN_CROP_SIZE, canvas.width - inset * 2),
    height: Math.max(MIN_CROP_SIZE, canvas.height - inset * 2),
    fill: 'transparent',
    stroke,
    strokeDashArray: [8, 6],
    strokeWidth: 2,
    editorRole: CROP_ROLE,
    excludeFromExport: true,
    lockRotation: true,
    hasRotatingPoint: false,
  });
  crop.setControlsVisibility({ mtr: false });
  addCropMask({ canvas, fabric, bounds: cropBounds(canvas, crop) });
  canvas.add(crop);
  canvas.setActiveObject(crop);
  cropRef.current = crop;
  canvas.requestRenderAll();
  return crop;
}

export function cancelCrop({
  canvas,
  cropRef,
}: {
  canvas: Canvas;
  cropRef: { current: Rect | null };
}) {
  removeCropUi(canvas);
  cropRef.current = null;
  canvas.discardActiveObject();
  canvas.requestRenderAll();
}

export function refreshCropMask({
  canvas,
  fabric,
  cropRef,
}: {
  canvas: Canvas;
  fabric: typeof import('fabric');
  cropRef: { current: Rect | null };
}) {
  const crop = cropRef.current;
  if (!crop) return;
  const scaleX = Math.min(crop.scaleX ?? 1, canvas.width / Math.max(1, crop.width ?? 1));
  const scaleY = Math.min(crop.scaleY ?? 1, canvas.height / Math.max(1, crop.height ?? 1));
  const width = (crop.width ?? 0) * scaleX;
  const height = (crop.height ?? 0) * scaleY;
  crop.set({
    scaleX,
    scaleY,
    left: Math.max(0, Math.min(canvas.width - width, crop.left ?? 0)),
    top: Math.max(0, Math.min(canvas.height - height, crop.top ?? 0)),
  });
  removeCropMasks(canvas);
  addCropMask({ canvas, fabric, bounds: cropBounds(canvas, crop) });
  canvas.bringObjectToFront(crop);
  canvas.requestRenderAll();
}

export function applyCrop({
  canvas,
  sourceImage,
  cropRef,
}: {
  canvas: Canvas;
  sourceImage: import('fabric').FabricImage;
  cropRef: { current: Rect | null };
}) {
  const crop = cropRef.current;
  if (!crop) return false;
  const bounds = cropBounds(canvas, crop);
  if (bounds.width < MIN_CROP_SIZE || bounds.height < MIN_CROP_SIZE) return false;
  const cropX = Number(sourceImage.get('cropX') ?? 0) + bounds.left;
  const cropY = Number(sourceImage.get('cropY') ?? 0) + bounds.top;
  removeCropUi(canvas);
  canvas
    .getObjects()
    .forEach((object) =>
      object.set({ left: (object.left ?? 0) - bounds.left, top: (object.top ?? 0) - bounds.top }),
    );
  sourceImage.set({
    cropX,
    cropY,
    width: bounds.width,
    height: bounds.height,
    left: 0,
    top: 0,
    scaleX: 1,
    scaleY: 1,
  });
  canvas.setDimensions({ width: bounds.width, height: bounds.height });
  cropRef.current = null;
  canvas.discardActiveObject();
  canvas.requestRenderAll();
  return true;
}
