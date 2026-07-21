import { useLayoutEffect, useRef, useState } from 'react';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import { Box, Button, Tooltip } from '@mui/material';

import type { MessageMediaInfo } from '../../../../../Bindings';
import { getMuiPaletteMode, useMuiPaletteMode } from '../../../mui-theme';
import { MessageCardVideoPreviewDialog } from './MessageCardVideoPreviewDialog';

const AUDIO_PLAYER_MIN_HEIGHT_PX = 72;
const AUDIO_PLAYER_TOP_PADDING_PX = 0;
const AUDIO_PLAYER_Z_INDEX = 0;
const AUDIO_DERIVED_IMAGE_MAX_SOURCE_SIZE_BYTES = 100 * 1024 * 1024;

const AUDIO_FILE_EXTENSIONS = [
  '.mp3',
  '.mpeg',
  '.mpga',
  '.wav',
  '.ogg',
  '.oga',
  '.opus',
  '.m4a',
  '.aac',
  '.flac',
  '.webm',
] as const;

const AUDIO_FILE_EXTENSION_RE = /\.(mp3|mpeg|mpga|wav|ogg|oga|opus|m4a|aac|flac|webm)(\?|#|$)/i;

type MessageMediaInfoRaw = MessageMediaInfo & {
  content_type?: string | null;
  file_name?: string | null;
  size_bytes?: number | null;
};

export function mediaAttachmentContentType(m: MessageMediaInfo): string {
  const raw = m as MessageMediaInfoRaw;
  return String(m.contentType ?? raw.content_type ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

export function isImageMediaAttachment(m: MessageMediaInfo): boolean {
  const ct = mediaAttachmentContentType(m);
  if (ct.startsWith('image/')) return true;
  if (ct !== '') return false;
  const href = String(m.href ?? '').toLowerCase();
  return /\.(jpe?g|png|gif|webp|bmp|svg)(\?|#|$)/i.test(href);
}

export function isAudioMediaAttachment(m: MessageMediaInfo): boolean {
  const ct = mediaAttachmentContentType(m);
  if (ct.startsWith('audio/')) return true;
  if (ct.startsWith('image/') || isVideoMediaAttachment(m)) return false;
  if (ct.includes('mpeg') || ct.includes('mp3')) return true;
  const fileName = mediaAttachmentDisplayName(m).toLowerCase();
  if (AUDIO_FILE_EXTENSIONS.some((ext) => fileName.endsWith(ext))) return true;
  const href = String(m.href ?? '').toLowerCase();
  return AUDIO_FILE_EXTENSION_RE.test(href);
}

const VIDEO_FILE_EXTENSIONS = [
  '.mp4',
  '.m4v',
  '.mov',
  '.webm',
  '.mkv',
  '.avi',
  '.mpeg',
  '.mpg',
  '.wmv',
  '.flv',
  '.f4v',
  '.3gp',
  '.3g2',
  '.m2ts',
  '.ogv',
  '.vob',
  '.asf',
] as const;

const VIDEO_FILE_EXTENSION_RE =
  /\.(mp4|m4v|mov|webm|mkv|avi|mpeg|mpg|wmv|flv|f4v|3gp|3g2|m2ts|ogv|vob|asf)(\?|#|$)/i;
const VIDEO_APPLICATION_CONTENT_TYPES = ['application/mp4', 'application/x-matroska'] as const;

function hasVideoFileExtension(m: MessageMediaInfo): boolean {
  const fileName = mediaAttachmentDisplayName(m).toLowerCase();
  if (VIDEO_FILE_EXTENSIONS.some((ext) => fileName.endsWith(ext))) return true;
  return VIDEO_FILE_EXTENSION_RE.test(String(m.href ?? '').toLowerCase());
}

export function isVideoMediaAttachment(m: MessageMediaInfo): boolean {
  const ct = mediaAttachmentContentType(m);
  if (
    ct.startsWith('video/') ||
    VIDEO_APPLICATION_CONTENT_TYPES.some((contentType) => contentType === ct)
  ) {
    return true;
  }
  if (ct.startsWith('audio/') || ct.startsWith('image/')) return false;
  return hasVideoFileExtension(m);
}

export function mediaAttachmentDisplayName(m: MessageMediaInfo): string {
  const raw = m as MessageMediaInfoRaw;
  const s = (m.fileName ?? raw.file_name ?? '').trim();
  if (s !== '') return s;
  return '<файл без назви>';
}

function mediaAttachmentSizeBytes(m: MessageMediaInfo): number | null {
  const raw = m as MessageMediaInfoRaw;
  return m.sizeBytes ?? raw.size_bytes ?? null;
}

const MESSENGER_MEDIA_PATH_RE = /\/api\/messenger\/media\/([^/?#]+)/;

export function resolveMediaAttachmentId(attachment: MessageMediaInfo): string {
  const id = String(attachment.id ?? '').trim();
  if (id !== '') return id;
  const match = MESSENGER_MEDIA_PATH_RE.exec(String(attachment.href ?? ''));
  return match?.[1]?.trim() ?? '';
}

export function mediaAttachmentWaveUrl(mediaId: string): string {
  return `/api/messenger/media/${mediaId}/wave`;
}

export function mediaAttachmentSpectrumUrl(mediaId: string): string {
  return `/api/messenger/media/${mediaId}/spectrogram`;
}

export function mediaAttachmentThumbnailUrl(mediaId: string): string {
  return `/api/messenger/media/${mediaId}/thumbnail`;
}

export function syncAudioPlayerTheme(player: HTMLElement, paletteMode: 'light' | 'dark') {
  player.setAttribute('theme', paletteMode);
}

export function MessageMediaAudioPlayer({ attachment }: { attachment: MessageMediaInfo }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLElement | null>(null);
  const paletteMode = useMuiPaletteMode();
  const displayName = mediaAttachmentDisplayName(attachment);
  const href = String(attachment.href ?? '');
  const mediaId = resolveMediaAttachmentId(attachment);
  const sizeBytes = mediaAttachmentSizeBytes(attachment);
  const hasExplicitAudioType = mediaAttachmentContentType(attachment).startsWith('audio/');
  const canLoadDerivedImages =
    (hasExplicitAudioType || !hasVideoFileExtension(attachment)) &&
    (sizeBytes == null || sizeBytes <= AUDIO_DERIVED_IMAGE_MAX_SOURCE_SIZE_BYTES);
  const waveSrc = mediaId !== '' && canLoadDerivedImages ? mediaAttachmentWaveUrl(mediaId) : '';
  const spectrumSrc =
    mediaId !== '' && canLoadDerivedImages ? mediaAttachmentSpectrumUrl(mediaId) : '';
  const storageKey = `echo-inbox-${mediaId || displayName}`;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || href === '') return;

    const player = document.createElement('custom-audio-player');
    player.setAttribute('src', href);
    player.setAttribute('mode', 'compact');
    player.setAttribute('storage-key', storageKey);
    player.setAttribute('theme', getMuiPaletteMode());
    if (displayName !== '<файл без назви>') {
      player.setAttribute('file-name', displayName);
    }
    if (waveSrc !== '') {
      player.setAttribute('wave-src', waveSrc);
    }
    if (spectrumSrc !== '') {
      player.setAttribute('spectrum-src', spectrumSrc);
    }
    host.replaceChildren(player);
    playerRef.current = player;

    return () => {
      playerRef.current = null;
      host.replaceChildren();
    };
  }, [href, storageKey, waveSrc, spectrumSrc, displayName]);

  useLayoutEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    syncAudioPlayerTheme(player, paletteMode);
  }, [paletteMode]);

  if (href === '') return null;

  return (
    <Box sx={{ mb: 0.5, width: '100%', maxWidth: 460, minWidth: 0 }}>
      <Box
        ref={hostRef}
        data-audio-player-host
        data-audio-player-min-height-px={AUDIO_PLAYER_MIN_HEIGHT_PX}
        data-audio-player-top-padding-px={AUDIO_PLAYER_TOP_PADDING_PX}
        data-audio-player-z-index={AUDIO_PLAYER_Z_INDEX}
        sx={{
          position: 'relative',
          zIndex: AUDIO_PLAYER_Z_INDEX,
          width: '100%',
          minWidth: 0,
          minHeight: AUDIO_PLAYER_MIN_HEIGHT_PX,
          pt: `${AUDIO_PLAYER_TOP_PADDING_PX}px`,
          pb: 0.5,
          display: 'flex',
          alignItems: 'stretch',
          overflow: 'hidden',
        }}
      />
    </Box>
  );
}

export function MessageMediaDownloadLink({ attachment }: { attachment: MessageMediaInfo }) {
  const displayName = mediaAttachmentDisplayName(attachment);
  const downloadAttr =
    displayName === '<файл без назви>' ? 'attachment' : displayName.replace(/[/\\]/g, '_');
  return (
    <Tooltip title={displayName} enterDelay={400}>
      <Button
        component="a"
        size="small"
        variant="outlined"
        href={String(attachment.href ?? '')}
        download={downloadAttr}
        target="_blank"
        rel="noopener noreferrer"
        sx={{
          mb: 0.5,
          width: 'fit-content',
          minWidth: 0,
          maxWidth: '100%',
          minHeight: 26,
          py: 0.25,
          px: 0.75,
          fontSize: 11,
          lineHeight: 1.25,
          textTransform: 'none',
          fontWeight: 500,
          alignSelf: 'flex-start',
          overflow: 'hidden',
          justifyContent: 'flex-start',
          '& .MuiButton-startIcon': {
            mr: 0.35,
            ml: -0.25,
            '& svg': { fontSize: 14 },
          },
        }}
        startIcon={<DownloadOutlinedIcon aria-hidden />}
      >
        <Box
          component="span"
          sx={{
            display: 'block',
            minWidth: 0,
            width: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            verticalAlign: 'bottom',
          }}
        >
          {displayName}
        </Box>
      </Button>
    </Tooltip>
  );
}

export function MessageMediaDownloadAllLink({ messageId }: { messageId: number }) {
  return (
    <a
      href={`/api/rer-importer/messages/${messageId}/attachments.zip`}
      download="attachments.zip"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Завантажити все"
      className="mb-0.5 inline-flex min-h-[26px] self-center items-center justify-center gap-1 rounded border border-solid border-(--color-divider) px-2 py-0.5 text-[11px] font-medium leading-tight text-(--color-text) no-underline hover:bg-(--color-hover)"
    >
      <DownloadOutlinedIcon aria-hidden fontSize="small" />
      Завантажити все
    </a>
  );
}

export function MessageMediaVideoPreviewButton({
  attachment,
  onClick,
}: {
  attachment: MessageMediaInfo;
  onClick: () => void;
}) {
  const displayName = mediaAttachmentDisplayName(attachment);

  return (
    <Tooltip title={displayName} enterDelay={400}>
      <Button
        size="small"
        variant="outlined"
        onClick={onClick}
        sx={{
          mb: 0.5,
          width: 'fit-content',
          minWidth: 0,
          maxWidth: '100%',
          minHeight: 26,
          py: 0.25,
          px: 0.75,
          fontSize: 11,
          lineHeight: 1.25,
          textTransform: 'none',
          fontWeight: 500,
          alignSelf: 'flex-start',
          overflow: 'hidden',
          justifyContent: 'flex-start',
          '& .MuiButton-startIcon': {
            mr: 0.35,
            ml: -0.25,
            '& svg': { fontSize: 14 },
          },
        }}
        startIcon={<PlayCircleOutlineIcon aria-hidden />}
      >
        <Box
          component="span"
          sx={{
            display: 'block',
            minWidth: 0,
            width: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            verticalAlign: 'bottom',
          }}
        >
          {displayName}
        </Box>
      </Button>
    </Tooltip>
  );
}
