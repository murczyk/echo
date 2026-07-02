import type { InboxMessage, MessageMediaInfo } from '../../../../../Bindings';
import { isImageMediaAttachment } from './MessageCardMedia';

export type MessageCardImage = {
  id?: string | null;
  href: string;
  fileName?: string | null;
  sizeBytes?: number | null;
  contentType?: string | null;
};

function sanitizeDownloadFileName(fileName: string): string {
  return fileName.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').trim();
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function collectMessageImages(msg: InboxMessage): MessageCardImage[] {
  const imagesByHref = new Map<string, MessageCardImage>();

  const add = (image: MessageCardImage) => {
    const href = image.href.trim();
    if (href === '') return;
    const existing = imagesByHref.get(href);
    imagesByHref.set(href, existing == null ? { ...image, href } : { ...existing, ...image, href });
  };

  for (const href of msg.images ?? []) {
    add({ href });
  }

  for (const attachment of msg.media ?? []) {
    if (!isImageMediaAttachment(attachment)) continue;
    add(mapMessageMediaImage(attachment));
  }

  return Array.from(imagesByHref.values());
}

function mapMessageMediaImage(attachment: MessageMediaInfo): MessageCardImage {
  const rawAttachment = attachment as MessageMediaInfo & {
    content_type?: string | null;
    file_name?: string | null;
    size_bytes?: number | null;
  };

  return {
    id: attachment.id ?? null,
    href: String(attachment.href ?? ''),
    fileName: attachment.fileName ?? rawAttachment.file_name ?? null,
    sizeBytes: attachment.sizeBytes ?? rawAttachment.size_bytes ?? null,
    contentType: attachment.contentType ?? rawAttachment.content_type ?? null,
  };
}

export function sanitizeDerivedFileName(fileName: string, fallbackName: string): string {
  const sanitized = sanitizeDownloadFileName(fileName);
  return sanitized === '' ? fallbackName : sanitized;
}

export function deriveFileNameFromHref(href: string, fallbackName: string): string {
  if (href.trim() === '') return fallbackName;

  try {
    const url = new URL(href, window.location.href);
    const pathName = url.pathname.split('/').filter(Boolean).pop() ?? '';
    const decodedPathName = pathName === '' ? null : safeDecodeURIComponent(pathName);
    return sanitizeDerivedFileName(decodedPathName ?? pathName, fallbackName);
  } catch {
    const rawPathName = href.split('/').filter(Boolean).pop() ?? '';
    const pathName = rawPathName.split('?')[0].split('#')[0];
    const decodedPathName = pathName === '' ? null : safeDecodeURIComponent(pathName);
    return sanitizeDerivedFileName(decodedPathName ?? pathName, fallbackName);
  }
}

export function derivePreviewFileName(image: MessageCardImage, index: number): string {
  const fallbackName = `image-${index + 1}`;
  const fileName = image.fileName?.trim() ?? '';
  if (fileName !== '') {
    const sanitized = sanitizeDownloadFileName(fileName);
    return sanitized === '' ? fallbackName : sanitized;
  }
  return deriveFileNameFromHref(image.href, fallbackName);
}

export function deriveImageDownloadName(image: MessageCardImage, index: number): string {
  const fallbackName = `image-${index + 1}`;
  return sanitizeDerivedFileName(derivePreviewFileName(image, index), fallbackName);
}

export function formatSizeBytes(sizeBytes: number | null | undefined): string {
  if (!Number.isFinite(sizeBytes ?? Number.NaN) || (sizeBytes ?? 0) <= 0) return '—';
  const value = Number(sizeBytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value >= 10 * 1024 ? 0 : 1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function normalizePreviewIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

export type Point = {
  x: number;
  y: number;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function clampPan(
  point: Point,
  stageWidth: number,
  stageHeight: number,
  zoom: number,
): Point {
  const scale = zoom / 100;
  const maxX = Math.max(0, (stageWidth * (scale - 1)) / 2);
  const maxY = Math.max(0, (stageHeight * (scale - 1)) / 2);
  return {
    x: clamp(point.x, -maxX, maxX),
    y: clamp(point.y, -maxY, maxY),
  };
}
