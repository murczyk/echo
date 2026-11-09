import { useEffect, useState } from 'react';
import { Box, CircularProgress } from '@mui/material';
import type {
  FilePreviewLifecycleProps,
  FilePreviewSource,
} from '../../shared/message-card/attachment-preview/file-preview-source';
import { AttachmentPreviewZoomBadge } from '../../shared/message-card/attachment-preview/AttachmentPreviewZoomBadge';
import { getAttachmentPreviewStageBg } from '../../shared/message-card/attachment-preview/message-card-attachment-preview';
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
  onImageLoad,
}: {
  source: FilePreviewSource;
  lifecycle: FilePreviewLifecycleProps;
  onImageLoad?: (image: HTMLImageElement) => void;
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
    <Box
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      sx={{ backgroundColor: getAttachmentPreviewStageBg }}
    >
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
          onLoad={(image) => {
            gestures.registerImage(image);
            onImageLoad?.(image);
          }}
          onError={() => {
            if (isCurrent()) onError(new Error('Не вдалося відкрити зображення.'));
          }}
        />
        <AttachmentPreviewZoomBadge
          zoom={gestures.zoom}
          onResetZoom={() => gestures.setPreviewZoom(100)}
        />
      </MessageCardAttachmentPreviewStage>
    </Box>
  );
}
