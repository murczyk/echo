type ClipboardItemLike = typeof ClipboardItem & {
  supports?: (type: string) => boolean;
};

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('Canvas export failed.'));
        return;
      }
      resolve(blob);
    }, type);
  });
}

function hasClipboardWriteSupport(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function' &&
    typeof window !== 'undefined' &&
    typeof window.ClipboardItem === 'function'
  );
}

function hasImageDimensions(image: HTMLImageElement): boolean {
  return image.naturalWidth > 0 && image.naturalHeight > 0;
}

function isClipboardImageMimeTypeSupported(mimeType: string): boolean {
  if (!mimeType.startsWith('image/')) return false;
  const clipboardItem = window.ClipboardItem as ClipboardItemLike | undefined;
  if (clipboardItem?.supports != null) return clipboardItem.supports(mimeType);
  return true;
}

async function writeBlobToClipboard(blob: Blob, mimeType: string): Promise<void> {
  if (!hasClipboardWriteSupport()) {
    throw new Error('Копіювання зображень недоступне.');
  }
  if (!isClipboardImageMimeTypeSupported(mimeType)) {
    throw new Error('Копіювання зображень недоступне.');
  }

  const clipboardItem = new window.ClipboardItem({ [mimeType]: blob });
  await navigator.clipboard.write([clipboardItem]);
}

async function writeBlobPromiseToClipboard(
  blobPromise: Promise<Blob>,
  mimeType: string,
): Promise<void> {
  if (!hasClipboardWriteSupport()) {
    throw new Error('Копіювання зображень недоступне.');
  }
  if (!isClipboardImageMimeTypeSupported(mimeType)) {
    throw new Error('Копіювання зображень недоступне.');
  }

  const clipboardItem = new window.ClipboardItem({ [mimeType]: blobPromise });
  await navigator.clipboard.write([clipboardItem]);
}

async function createCanvasImageBlob(image: HTMLImageElement): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('Canvas context is unavailable.');
  }

  context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
  return toBlob(canvas, 'image/png');
}

async function fetchImageBlob(href: string): Promise<{ blob: Blob; mimeType: string }> {
  const response = await fetch(href, { credentials: 'include' });
  if (!response.ok) {
    throw new Error('Image fetch failed.');
  }

  const blob = await response.blob();
  const responseType =
    blob.type.trim() === '' ? (response.headers.get('content-type') ?? '') : blob.type;
  const mimeType = responseType.split(';')[0]?.trim() ?? '';

  if (mimeType === '') {
    throw new Error('Image MIME type is unavailable.');
  }

  return { blob, mimeType };
}

export function canCopyImageToClipboard(image: HTMLImageElement): boolean {
  return hasClipboardWriteSupport() && hasImageDimensions(image);
}

export async function copyImageToClipboard(image: HTMLImageElement, href: string): Promise<void> {
  if (!canCopyImageToClipboard(image)) {
    throw new Error('Копіювання зображень недоступне.');
  }

  let mimeType = 'image/png';
  const canvasBlobPromise = createCanvasImageBlob(image);

  try {
    await writeBlobPromiseToClipboard(canvasBlobPromise, mimeType);
    return;
  } catch {
    canvasBlobPromise.catch(() => undefined);
    const fetched = await fetchImageBlob(href);
    const blob = fetched.blob;
    mimeType = fetched.mimeType;
    await writeBlobToClipboard(blob, mimeType);
  }
}
