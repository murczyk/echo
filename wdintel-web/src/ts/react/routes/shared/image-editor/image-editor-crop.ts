type Canvas = import('fabric').Canvas;
type Rect = import('fabric').Rect;
import { ImageEditorObjectRole } from './image-editor.types';
import { isTransientCropRole } from './image-editor-object-role';
import { translateImageEditorAttachedArrowTarget } from './image-editor-attached-arrow';

const MIN_CROP_SIZE = 8;
const CROP_CONTROL_INSET = 8;
const cropScalingByCanvas = new WeakMap<
  Canvas,
  { uniformScaling: boolean; uniScaleKey: Canvas['uniScaleKey'] }
>();

function configureCropScaling(canvas: Canvas) {
  if (!cropScalingByCanvas.has(canvas))
    cropScalingByCanvas.set(canvas, {
      uniformScaling: canvas.uniformScaling,
      uniScaleKey: canvas.uniScaleKey,
    });
  canvas.uniformScaling = false;
  canvas.uniScaleKey = 'shiftKey';
}

function restoreCropScaling(canvas: Canvas) {
  const previous = cropScalingByCanvas.get(canvas);
  if (!previous) return;
  canvas.uniformScaling = previous.uniformScaling;
  canvas.uniScaleKey = previous.uniScaleKey;
  cropScalingByCanvas.delete(canvas);
}

export function normalizedCropFrame({
  left,
  top,
  width,
  height,
  scaleX,
  scaleY,
  canvasWidth,
  canvasHeight,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  canvasWidth: number;
  canvasHeight: number;
}) {
  const normalizedWidth = Math.max(MIN_CROP_SIZE, Math.min(canvasWidth, width * Math.abs(scaleX)));
  const normalizedHeight = Math.max(
    MIN_CROP_SIZE,
    Math.min(canvasHeight, height * Math.abs(scaleY)),
  );
  return {
    left: Math.max(0, Math.min(canvasWidth - normalizedWidth, left)),
    top: Math.max(0, Math.min(canvasHeight - normalizedHeight, top)),
    width: normalizedWidth,
    height: normalizedHeight,
    scaleX: 1,
    scaleY: 1,
  };
}

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
    if (isTransientCropRole(object.get('editorRole'))) canvas.remove(object);
  });
}

function removeCropMasks(canvas: Canvas) {
  canvas.getObjects().forEach((object) => {
    if (object.get('editorRole') === ImageEditorObjectRole.CropMask) canvas.remove(object);
  });
}

function addCropMask({
  canvas,
  fabric,
  bounds,
  maskColor,
}: {
  canvas: Canvas;
  fabric: typeof import('fabric');
  bounds: ReturnType<typeof cropBounds>;
  maskColor: string;
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
          originX: 'left',
          originY: 'top',
          fill: maskColor,
          selectable: false,
          evented: false,
          editorRole: ImageEditorObjectRole.CropMask,
          excludeFromExport: true,
        }),
      );
    });
}

function insetCropControls(fabric: typeof import('fabric'), crop: Rect) {
  if (!crop.controls || !fabric.Control) return;
  const offsets = {
    tl: [CROP_CONTROL_INSET, CROP_CONTROL_INSET],
    mt: [0, CROP_CONTROL_INSET],
    tr: [-CROP_CONTROL_INSET, CROP_CONTROL_INSET],
    ml: [CROP_CONTROL_INSET, 0],
    mr: [-CROP_CONTROL_INSET, 0],
    bl: [CROP_CONTROL_INSET, -CROP_CONTROL_INSET],
    mb: [0, -CROP_CONTROL_INSET],
    br: [-CROP_CONTROL_INSET, -CROP_CONTROL_INSET],
  } as const;
  for (const [key, [offsetX, offsetY]] of Object.entries(offsets)) {
    const control = crop.controls[key];
    if (control) crop.controls[key] = new fabric.Control({ ...control, offsetX, offsetY });
  }
}

export function startCrop({
  canvas,
  fabric,
  cropRef,
  stroke,
  maskColor,
}: {
  canvas: Canvas;
  fabric: typeof import('fabric');
  cropRef: { current: Rect | null };
  stroke: string;
  maskColor: string;
}) {
  if (cropRef.current) return cropRef.current;
  configureCropScaling(canvas);
  const crop = new fabric.Rect({
    left: 0,
    top: 0,
    originX: 'left',
    originY: 'top',
    width: canvas.width,
    height: canvas.height,
    fill: 'transparent',
    stroke,
    strokeDashArray: [8, 6],
    strokeWidth: 2,
    editorRole: ImageEditorObjectRole.Crop,
    excludeFromExport: true,
    lockRotation: true,
    lockScalingFlip: true,
    hasRotatingPoint: false,
  });
  crop.setControlsVisibility({ mtr: false });
  insetCropControls(fabric, crop);
  crop.set({ cornerColor: stroke, cornerStrokeColor: stroke, transparentCorners: false });
  crop.setCoords();
  addCropMask({ canvas, fabric, bounds: cropBounds(canvas, crop), maskColor });
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
  restoreCropScaling(canvas);
  canvas.discardActiveObject();
  canvas.requestRenderAll();
}

export function refreshCropMask({
  canvas,
  fabric,
  cropRef,
  maskColor,
}: {
  canvas: Canvas;
  fabric: typeof import('fabric');
  cropRef: { current: Rect | null };
  maskColor: string;
}) {
  const crop = cropRef.current;
  if (!crop) return;
  const width = Math.max(0, (crop.width ?? 0) * Math.abs(crop.scaleX ?? 1));
  const height = Math.max(0, (crop.height ?? 0) * Math.abs(crop.scaleY ?? 1));
  const scaleX = Math.min(Math.abs(crop.scaleX ?? 1), canvas.width / Math.max(1, crop.width ?? 1));
  const scaleY = Math.min(
    Math.abs(crop.scaleY ?? 1),
    canvas.height / Math.max(1, crop.height ?? 1),
  );
  crop.set({
    scaleX,
    scaleY,
    left: Math.max(0, Math.min(Math.max(0, canvas.width - width), crop.left ?? 0)),
    top: Math.max(0, Math.min(Math.max(0, canvas.height - height), crop.top ?? 0)),
  });
  removeCropMasks(canvas);
  crop.setCoords();
  addCropMask({ canvas, fabric, bounds: cropBounds(canvas, crop), maskColor });
  canvas.bringObjectToFront(crop);
  canvas.requestRenderAll();
}

export function normalizeCrop({
  canvas,
  fabric,
  cropRef,
  maskColor,
}: {
  canvas: Canvas;
  fabric: typeof import('fabric');
  cropRef: { current: Rect | null };
  maskColor: string;
}) {
  const crop = cropRef.current;
  if (!crop) return;
  crop.set(
    normalizedCropFrame({
      left: crop.left ?? 0,
      top: crop.top ?? 0,
      width: crop.width ?? 0,
      height: crop.height ?? 0,
      scaleX: crop.scaleX ?? 1,
      scaleY: crop.scaleY ?? 1,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    }),
  );
  removeCropMasks(canvas);
  crop.setCoords();
  addCropMask({ canvas, fabric, bounds: cropBounds(canvas, crop), maskColor });
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
  canvas.getObjects().forEach((object) => {
    if (object.get('editorRole') === ImageEditorObjectRole.DerivedArrow) return;
    if (object.get('editorRole') === ImageEditorObjectRole.Text)
      translateImageEditorAttachedArrowTarget(
        object as import('fabric').IText,
        bounds.left,
        bounds.top,
      );
    object.set({ left: (object.left ?? 0) - bounds.left, top: (object.top ?? 0) - bounds.top });
  });
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
  restoreCropScaling(canvas);
  canvas.discardActiveObject();
  canvas.requestRenderAll();
  return true;
}
