import BrokenImageOutlinedIcon from '@mui/icons-material/BrokenImageOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { useState } from 'react';

import type { MessageMediaInfo } from '../../../../../Bindings';
import { mediaAttachmentThumbnailUrl } from '../../shared/message-card/MessageCardMedia';
import { useGalleryThumbnail } from '../messenger-gallery-thumbnails';

// The thumbnail of a photo or video, from the gallery's session cache of thumbnails (`messenger-gallery-thumbnails.ts`): a tile
// that comes back after a scroll shows at once and asks for nothing, and a thumbnail that is still being made is asked for again
// there. When it never comes a photo falls back to its original (only a small one: a gallery of failing thumbnails must not
// pull a screenful of multi-megabyte originals), otherwise, and for a video, the tile shows the broken-image icon with a
// tooltip that says why.
const FAILED_PHOTO_HINT =
  'Мініатюру не вдалося завантажити, а оригінал завеликий або недоступний для показу тут. Файл можна відкрити або завантажити.';
const FAILED_VIDEO_HINT =
  'Мініатюру відео не вдалося завантажити. Відео можна відкрити або завантажити.';
const ORIGINAL_FALLBACK_MAX_BYTES = 2 * 1024 * 1024;

// A photo up to this size is shown from its original, not from a thumbnail.
//
// WHY: a thumbnail does not exist until the server makes one, on the first view of the media: that is a generation job, a 202 answer
// and a retry a second later, so the tile stays a skeleton for at least a second, and the route does its access checks per request
// (B9). Until thumbnails are made ahead of time (static thumbnails, plan B8) that wait is the main cost of the grid. A small
// original is a single request that shows at once. In the local data 71% of the photos are 200 KB or less (median 144 KB, a
// thumbnail is 10 to 20 KB), so most of the jobs are never started. It is only for Telegram photos (the Photo tab holds nothing
// else, see `GALLERY_TAB_TELEGRAM_TYPES`): Telegram stores them as JPEGs of at most about 1280 px, so the size is a safe
// stand-in for the decoded size (the media has no width and height). The original route is `no-store`, so the originals are kept
// by the session cache of `messenger-gallery-thumbnails.ts` (capped in bytes), not by the browser.
//
// TODO(remove with B8, plan "Gallery: decisions and open points"): delete this constant, `showsOriginal` and the original case of
// `GalleryThumbImage` once the backend makes thumbnails at ingest (`has_preview` / a preview href) and a thumbnail is ready when
// the tile asks for it. Then every photo goes through the thumbnail again, whatever its size.
export const ORIGINAL_INSTEAD_OF_THUMBNAIL_MAX_BYTES = 200 * 1024;

const showsOriginal = (media: MessageMediaInfo, video: boolean) =>
  !video &&
  media.contentType === 'image/jpeg' &&
  media.sizeBytes <= ORIGINAL_INSTEAD_OF_THUMBNAIL_MAX_BYTES;

export function GalleryThumbImage({ media, video }: { media: MessageMediaInfo; video: boolean }) {
  const original = showsOriginal(media, video);
  const thumbnail = useGalleryThumbnail(
    original ? media.href : mediaAttachmentThumbnailUrl(media.id),
  );
  const [loaded, setLoaded] = useState(() => thumbnail.src != null);
  const [originalFailed, setOriginalFailed] = useState(false);
  // The thumbnail arrived but the browser cannot draw it.
  const [undrawable, setUndrawable] = useState(false);

  // The fallback to the original is for a thumbnail that failed; an original that failed has nothing to fall back to.
  const useOriginal =
    thumbnail.failed && !video && !original && media.sizeBytes <= ORIGINAL_FALLBACK_MAX_BYTES;
  const failed = undrawable || (thumbnail.failed && (!useOriginal || originalFailed));
  const src = thumbnail.src ?? (useOriginal ? media.href : null);

  return (
    <div className="absolute inset-0 overflow-hidden rounded-md">
      {!loaded && !failed ? (
        <div className="absolute inset-0 animate-pulse bg-[var(--color-divider)]" />
      ) : null}
      {failed ? (
        <div
          className="absolute inset-0 flex items-center justify-center text-[var(--color-text-muted)]"
          title={video ? FAILED_VIDEO_HINT : FAILED_PHOTO_HINT}
        >
          <BrokenImageOutlinedIcon aria-label="Зображення недоступне" />
        </div>
      ) : src != null ? (
        <img
          key={src}
          src={src}
          alt=""
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() =>
            thumbnail.src == null && useOriginal ? setOriginalFailed(true) : setUndrawable(true)
          }
          className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-[120ms] ease-out ${
            loaded ? 'opacity-100' : 'opacity-0'
          }`}
        />
      ) : null}
      {video ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <PlayArrowIcon className="text-[32px] text-white drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]" />
        </div>
      ) : null}
    </div>
  );
}
