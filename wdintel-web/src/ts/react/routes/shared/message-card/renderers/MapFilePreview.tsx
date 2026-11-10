import { useEffect, useState } from 'react';
import { CircularProgress } from '@mui/material';
import { BaseLayerId, DEFAULT_BASE_LAYER_ID } from '../../../../../maps/base-layers';
import type {
  FilePreviewLifecycleProps,
  FilePreviewSource,
} from '../attachment-preview/file-preview-source';
import { CoordinateMapPreviewControls } from '../CoordinateMapPreviewControls';
import { KmzAttachmentPreviewMap } from '../KmzAttachmentPreviewMap';
import { fetchCachedDocumentResponse } from '../document-preview-utils';
import {
  MAX_KMZ_PREVIEW_SOURCE_BYTES,
  kmzPreviewErrorCopy,
  type NativeMapFormat,
} from '../kmz/kmz-preview-utils';
import type { KmzPreview } from '../kmz/kmz-preview-types';
import { FilePreviewRenderError } from '../attachment-preview/file-preview-source';
import { HttpRequestError } from '../../../../services/api/client';
import { runWorkerTask } from '../workers/worker-client';

export function hasMapGeometry(preview: KmzPreview) {
  return (
    preview.points.length > 0 ||
    preview.lineStrings.some((line) => line.coords.length >= 2) ||
    preview.polygons.some((polygon) => polygon.rings.some((ring) => ring.length >= 3))
  );
}
export function MapFileSurface({
  preview,
  baseLayerId,
}: {
  preview: KmzPreview;
  baseLayerId: BaseLayerId;
}) {
  return (
    <div
      className="relative flex h-full min-h-96 w-full flex-1 flex-col"
      data-map-preview-points={preview.points.length}
      data-map-preview-lines={preview.lineStrings.length}
      data-map-preview-polygons={preview.polygons.length}
    >
      <KmzAttachmentPreviewMap preview={preview} baseLayerId={baseLayerId} />
    </div>
  );
}
export async function loadMapFilePreview({
  href,
  sizeBytes,
  maxBytes = MAX_KMZ_PREVIEW_SOURCE_BYTES,
  format,
  signal,
}: {
  href: string;
  sizeBytes: number | null;
  maxBytes?: number;
  format: NativeMapFormat;
  signal: AbortSignal;
}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20_000);
  try {
    if (sizeBytes != null && sizeBytes > maxBytes) throw new Error('KMZ_SOURCE_TOO_LARGE');
    const { buffer } = await fetchCachedDocumentResponse(
      href,
      maxBytes,
      'KMZ_SOURCE_TOO_LARGE',
      controller.signal,
    );
    return await runWorkerTask<
      { buffer: ArrayBuffer; format: NativeMapFormat; maxBytes: number },
      KmzPreview
    >(
      () =>
        new Worker(new URL('../kmz/kmz-preview.worker.ts', import.meta.url), { type: 'module' }),
      { buffer, format, maxBytes },
      controller.signal,
      [buffer],
      20_000,
    );
  } catch (error) {
    if (timedOut && !signal.aborted) throw new Error('KMZ_REQUEST_TIMEOUT');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
export function MapFilePreview({
  source,
  format,
  lifecycle,
}: {
  source: FilePreviewSource;
  format: NativeMapFormat;
  lifecycle: FilePreviewLifecycleProps;
}) {
  const [preview, setPreview] = useState<KmzPreview | null>(null);
  const [baseLayerId, setBaseLayerId] = useState<BaseLayerId>(DEFAULT_BASE_LAYER_ID);
  const { signal, onError, isCurrent } = lifecycle;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    setPreview(null);
    if (!controller.signal.aborted && isCurrent()) {
      void loadMapFilePreview({
        href: source.originalHref,
        sizeBytes: source.sizeBytes,
        maxBytes: source.maxPreviewBytes,
        format,
        signal: controller.signal,
      })
        .then((result) => {
          if (active && !signal.aborted && isCurrent()) setPreview(result);
        })
        .catch((error) => {
          if (active && !signal.aborted && isCurrent())
            onError(
              error instanceof Error && !(error instanceof HttpRequestError)
                ? new FilePreviewRenderError(
                    error.message === 'KMZ_SOURCE_TOO_LARGE' && source.maxPreviewBytes != null
                      ? 'Файл завеликий для попереднього перегляду. Максимум: 1 ГБ.'
                      : kmzPreviewErrorCopy(error.message),
                    /TIMEOUT/.test(error.message),
                  )
                : error,
            );
        });
    }
    return () => {
      active = false;
      controller.abort();
      signal.removeEventListener('abort', abort);
    };
  }, [
    source.key,
    source.originalHref,
    source.sizeBytes,
    source.maxPreviewBytes,
    format,
    signal,
    onError,
    isCurrent,
  ]);
  if (!preview) return <CircularProgress aria-label="Читання мапи" />;
  if (!hasMapGeometry(preview))
    return <p className="p-echo-lg">У файлі немає геометрій для попереднього перегляду.</p>;
  return (
    <div className="relative flex min-h-96 flex-1 flex-col">
      <MapFileSurface preview={preview} baseLayerId={baseLayerId} />
      <CoordinateMapPreviewControls baseLayerId={baseLayerId} onBaseLayerChange={setBaseLayerId} />
    </div>
  );
}
