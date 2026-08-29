type Canvas = import('fabric').Canvas;
import { ImageEditorObjectRole } from './image-editor.types';

export type ImageEditorDocumentSnapshot = {
  serializedCanvas: string;
  width: number;
  height: number;
  background: {
    cropX: number;
    cropY: number;
    width: number;
    height: number;
    left: number;
    top: number;
    originX: import('fabric').TOriginX;
    originY: import('fabric').TOriginY;
    scaleX: number;
    scaleY: number;
  };
};

function withoutTransientCropUi(serialized: unknown) {
  if (!serialized || typeof serialized !== 'object') return serialized;
  const canvas = serialized as { objects?: unknown[] };
  return {
    ...canvas,
    objects: canvas.objects?.filter((object) => {
      if (!object || typeof object !== 'object') return true;
      const role = (object as { editorRole?: unknown }).editorRole;
      return role !== ImageEditorObjectRole.Crop && role !== ImageEditorObjectRole.CropMask;
    }),
  };
}

export function captureImageEditorDocumentSnapshot(canvas: Canvas): ImageEditorDocumentSnapshot {
  const background = canvas.backgroundImage as import('fabric').FabricImage;
  const serializableCanvas = canvas as unknown as { toJSON: (properties: string[]) => unknown };
  return {
    serializedCanvas: JSON.stringify(
      withoutTransientCropUi(serializableCanvas.toJSON(['editorRole'])),
    ),
    width: canvas.width,
    height: canvas.height,
    background: {
      cropX: Number(background.get('cropX') ?? 0),
      cropY: Number(background.get('cropY') ?? 0),
      width: background.width ?? canvas.width,
      height: background.height ?? canvas.height,
      left: background.left ?? 0,
      top: background.top ?? 0,
      originX: background.originX,
      originY: background.originY,
      scaleX: background.scaleX ?? 1,
      scaleY: background.scaleY ?? 1,
    },
  };
}
