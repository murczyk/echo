import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { CircularProgress } from '@mui/material';
import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import { deviceFileThumbnailUrl } from '../../../services/api/device-file-preview';
import { getFilePreviewKind } from '../../shared/message-card/file-preview-kind';
import { normalizeFilePreviewMetadata } from '../../shared/message-card/attachment-preview/file-preview-source';
import { useMediaThumbnail, useThumbnailRequestActivation } from '../../shared/use-media-thumbnail';
import type { ThumbnailRequestScheduler } from '../../shared/thumbnail-request-scheduler';
import {
  DEVICE_FILE_THUMBNAIL_MAX_BYTES,
  DEVICE_FILE_THUMBNAIL_MAX_WAIT_MS,
  DEVICE_FILE_THUMBNAIL_REQUEST_TIMEOUT_MS,
} from '../device-file-preview-config';
import { isDeviceFolder } from '../device-file-archive';
import { DeviceFileIcon } from './DeviceFileIcon';

export function DeviceFileThumbnail({
  deviceId,
  entry,
  scheduler,
  onFailure,
}: {
  deviceId: string;
  entry: DeviceFileTreeEntry;
  scheduler: ThumbnailRequestScheduler;
  onFailure: (status: number | null) => void;
}) {
  const metadata = normalizeFilePreviewMetadata({
    fileName: entry.name,
    extension: entry.extension,
    contentType: entry.mimeType,
  });
  const kind = getFilePreviewKind({
    ...metadata,
    key: entry.entryId,
    originalHref: '',
    sizeBytes: entry.sizeBytes,
  });
  const svg = metadata.extension === 'svg' || metadata.contentType === 'image/svg+xml';
  const oversized = entry.sizeBytes !== null && entry.sizeBytes > DEVICE_FILE_THUMBNAIL_MAX_BYTES;
  const media = kind === 'image' || kind === 'video';
  const eligible =
    !isDeviceFolder(entry) &&
    !svg &&
    !oversized &&
    entry.hasContent &&
    entry.fileId !== null &&
    entry.revision !== null &&
    entry.revision > 0 &&
    media;
  const source = eligible
    ? deviceFileThumbnailUrl({ deviceId, fileId: entry.fileId!, revision: entry.revision! })
    : '';
  const { targetRef, isActive } = useThumbnailRequestActivation<HTMLSpanElement>();
  const thumbnail = useMediaThumbnail(source, isActive, {
    cancelOnAuth: true,
    scheduler,
    retainLoadedOffscreen: true,
    maxWaitMs: DEVICE_FILE_THUMBNAIL_MAX_WAIT_MS,
    requestTimeoutMs: DEVICE_FILE_THUMBNAIL_REQUEST_TIMEOUT_MS,
    onFailure,
  });
  const loaded = thumbnail.state === 'loaded';
  const unavailable = !media
    ? undefined
    : !entry.hasContent
      ? 'Контент файлу відсутній'
      : oversized
        ? 'Мініатюра недоступна для файлів понад 1 ГБ'
        : svg
          ? 'Мініатюра SVG недоступна'
          : eligible && thumbnail.state === 'failed'
            ? 'Мініатюра недоступна. Файл можна відкрити звичайним способом.'
            : undefined;
  return (
    <span
      ref={targetRef}
      title={unavailable}
      data-device-file-thumbnail-state={eligible ? thumbnail.state : undefined}
      className="relative flex h-20 w-full shrink-0 items-center justify-center overflow-hidden rounded-echo-md bg-echo-surface text-echo-text"
    >
      {!loaded && <DeviceFileIcon entry={entry} className="size-12!" />}
      {thumbnail.imageSrc !== null && (
        <img
          key={source}
          data-device-file-thumbnail-image
          src={thumbnail.imageSrc}
          alt=""
          loading="lazy"
          decoding="async"
          {...{ fetchpriority: 'low' }}
          onLoad={thumbnail.markLoaded}
          onError={thumbnail.markFailed}
          className={`pointer-events-none absolute inset-0 h-full w-full object-cover ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
      {eligible && isActive && thumbnail.state === 'loading' && (
        <CircularProgress
          size={14}
          aria-label="Завантаження мініатюри"
          className="absolute! bottom-echo-xs right-echo-xs"
        />
      )}
      {loaded && kind === 'video' && (
        <span className="pointer-events-none absolute rounded-full bg-echo-surface/90 p-echo-xs">
          <PlayArrowIcon aria-hidden />
        </span>
      )}
    </span>
  );
}
