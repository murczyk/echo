import type { ImageEditorSource } from './image-editor.types';

const JPEG_QUALITY = 0.92;
const EDITABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function outputMimeType(source: ImageEditorSource) {
  return EDITABLE_TYPES.has(source.mimeType) ? source.mimeType : 'image/png';
}

function outputFileName(fileName: string, type: string) {
  const base = fileName.replace(/\.[^.]+$/, '') || 'image';
  const extension = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png';
  return `${base}.${extension}`;
}

export async function exportEditedImage({
  canvas,
  source,
  sourceImage,
  crop,
}: {
  canvas: import('fabric').Canvas;
  source: ImageEditorSource;
  sourceImage: import('fabric').FabricImage;
  crop: import('fabric').Rect | null;
}) {
  const viewport = [...(canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0])] as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  const bounds = crop?.getBoundingRect();
  if (crop && (!bounds || bounds.width < 1 || bounds.height < 1)) {
    canvas.setViewportTransform(viewport);
    throw new Error('Виберіть непорожню область для обрізання');
  }
  if (crop) crop.visible = false;
  try {
    const element = canvas.toCanvasElement(1, {
      left: bounds?.left ?? 0,
      top: bounds?.top ?? 0,
      width: bounds?.width ?? sourceImage.width,
      height: bounds?.height ?? sourceImage.height,
    });
    const requestedType = outputMimeType(source);
    const blob = await new Promise<Blob>((resolve, reject) =>
      element.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error('Не вдалося експортувати зображення')),
        requestedType,
        JPEG_QUALITY,
      ),
    );
    const type = blob.type || requestedType;
    return new File([blob], outputFileName(source.fileName, type), { type });
  } finally {
    if (crop) crop.visible = true;
    canvas.setViewportTransform(viewport);
  }
}
