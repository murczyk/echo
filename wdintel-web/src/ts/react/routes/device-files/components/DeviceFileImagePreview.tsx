import { useEffect, useState } from 'react';
import { CircularProgress, IconButton, Tooltip } from '@mui/material';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import type {
  FilePreviewLifecycleProps,
  FilePreviewSource,
} from '../../shared/message-card/attachment-preview/file-preview-source';
import { AttachmentPreviewZoomBadge } from '../../shared/message-card/attachment-preview/AttachmentPreviewZoomBadge';
import { MessageCardAttachmentPreviewStage } from '../../shared/message-card/attachment-preview/MessageCardAttachmentPreviewStage';
import { ImageFilePreview } from '../../shared/message-card/renderers/ImageFilePreview';
import { useImageAttachmentPreviewGestures } from '../../shared/message-card/renderers/use-image-attachment-preview-gestures';
import { getDeviceFilePreviewImage } from '../../../services/api/device-file-preview';

const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};
export function imagePreviewMime(source: FilePreviewSource) {
  return (
    IMAGE_MIME_TYPES[source.extension] ??
    (/^image\/[a-z0-9.+-]+$/.test(source.contentType) ? source.contentType : null) ??
    null
  );
}

export function DeviceFileImagePreview({
  source,
  lifecycle,
}: {
  source: FilePreviewSource;
  lifecycle: FilePreviewLifecycleProps;
}) {
  const [href, setHref] = useState<string | null>(null);
  const { signal, isCurrent, onError, registerCleanup } = lifecycle;
  const mime = imagePreviewMime(source);
  const gestures = useImageAttachmentPreviewGestures({
    previewKey: source.key,
    href: href ?? '',
    failedHref: null,
    interactionLocked: false,
    onBackgroundClick: () => {},
  });
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    const cleanup = () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    };
    const unregister = registerCleanup(cleanup);
    setHref(null);
    if (mime && !signal.aborted && isCurrent()) {
      void getDeviceFilePreviewImage(source.originalHref, signal)
        .then((blob) => {
          if (!active || signal.aborted || !isCurrent()) return;
          objectUrl = URL.createObjectURL(new Blob([blob], { type: mime }));
          setHref(objectUrl);
        })
        .catch((error) => {
          if (active && !signal.aborted && isCurrent()) onError(error);
        });
    }
    return () => {
      cleanup();
      unregister();
    };
  }, [source.key, source.originalHref, mime, signal, isCurrent, onError, registerCleanup]);
  useEffect(() => {
    const unregister = registerCleanup(gestures.cleanup);
    return () => {
      gestures.cleanup();
      unregister();
    };
  }, [registerCleanup, gestures.cleanup]);
  if (!href) return <CircularProgress aria-label="Завантаження зображення" />;
  return (
    <div className="relative flex min-h-64 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex justify-end">
        <Tooltip title="Зменшити">
          <IconButton
            aria-label="Зменшити зображення"
            disabled={gestures.zoom <= 100}
            onClick={() => gestures.setPreviewZoom(gestures.zoom - 25)}
          >
            <ZoomOutIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Збільшити">
          <IconButton
            aria-label="Збільшити зображення"
            disabled={gestures.zoom >= 400}
            onClick={() => gestures.setPreviewZoom(gestures.zoom + 25)}
          >
            <ZoomInIcon />
          </IconButton>
        </Tooltip>
      </div>
      <MessageCardAttachmentPreviewStage
        ref={gestures.stageRef}
        kind="image"
        cursor={gestures.zoom > 100 ? 'grab' : 'default'}
        onPointerDown={gestures.onPointerDown}
        onPointerMove={gestures.onPointerMove}
        onPointerUp={gestures.onPointerUp}
        onPointerCancel={gestures.onPointerCancel}
        onLostPointerCapture={gestures.onLostPointerCapture}
        onPrimaryClick={gestures.onPrimaryClick}
        getPrimaryPointerRegion={gestures.getPrimaryPointerRegion}
        activationKey={source.key}
      >
        <ImageFilePreview
          sizeBytes={source.sizeBytes}
          href={href}
          carouselIndex={0}
          previewFileName={source.fileName}
          zoom={gestures.zoom}
          pan={gestures.pan}
          failedHref={null}
          imageSize={gestures.imageSize}
          onLoad={gestures.registerImage}
          onError={() => {
            if (isCurrent()) onError(new Error('Не вдалося відкрити зображення.'));
          }}
        />
        <AttachmentPreviewZoomBadge
          zoom={gestures.zoom}
          onResetZoom={() => gestures.setPreviewZoom(100)}
        />
      </MessageCardAttachmentPreviewStage>
    </div>
  );
}
