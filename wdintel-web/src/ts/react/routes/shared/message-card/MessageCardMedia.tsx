import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import DownloadIcon from '@mui/icons-material/Download';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import { Box, Button, CircularProgress, IconButton, Tooltip } from '@mui/material';

import type { MessageMediaInfo } from '../../../../../Bindings';
import { getMuiPaletteMode, useMuiPaletteMode } from '../../../mui-theme';
import { MessageCardDisabledControlCursorWrapper } from './MessageCardDisabledControlCursorWrapper';
import {
  MessageCardAudioTranscription,
  useAudioTranscriptionPreferences,
} from './MessageCardAudioTranscription';

const AUDIO_PLAYER_MIN_HEIGHT_PX = 48;
const AUDIO_PLAYER_TOP_PADDING_PX = 0;
const AUDIO_PLAYER_Z_INDEX = 0;
const AUDIO_DERIVED_IMAGE_MAX_SOURCE_SIZE_BYTES = 100 * 1024 * 1024;
export const MESSAGE_CARD_DOWNLOAD_START_COOLDOWN_MS = 3_000;
export const MESSAGE_CARD_ATTACHMENTS_ARCHIVE_DOWNLOAD_KEY = 'archive';
export const MESSAGE_CARD_ATTACHMENTS_ARCHIVE_FILE_NAME = 'attachments.zip';
export const MESSAGE_CARD_ATTACHMENTS_ARCHIVE_LABEL = 'Завантажити все';
export const RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES = 20;
export const RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export type MessageCardDownloadGuardProps = {
  isDownloadStarting: (downloadKey: string) => boolean;
  onDownloadStart: (downloadKey: string) => boolean;
};

export function messageCardMediaDownloadKey(mediaId: string | number): string {
  return `media:${String(mediaId)}`;
}

export function guardMessageCardDownloadClick(
  event: MouseEvent<HTMLElement>,
  downloadKey: string,
  { isDownloadStarting, onDownloadStart }: MessageCardDownloadGuardProps,
) {
  if (isDownloadStarting(downloadKey) || !onDownloadStart(downloadKey)) {
    event.preventDefault();
  }
}

export function useMessageCardDownloadGuard(): MessageCardDownloadGuardProps {
  const [activeDownloadKeys, setActiveDownloadKeys] = useState<Set<string>>(() => new Set());
  const activeDownloadKeysRef = useRef<Set<string>>(new Set());
  const downloadCooldownTimersRef = useRef<Map<string, number>>(new Map());
  const isDownloadStarting = useCallback(
    (downloadKey: string) =>
      activeDownloadKeys.has(downloadKey) || activeDownloadKeysRef.current.has(downloadKey),
    [activeDownloadKeys],
  );
  const onDownloadStart = useCallback((downloadKey: string) => {
    if (activeDownloadKeysRef.current.has(downloadKey)) return false;
    const nextActiveDownloadKeys = new Set(activeDownloadKeysRef.current);
    nextActiveDownloadKeys.add(downloadKey);
    activeDownloadKeysRef.current = nextActiveDownloadKeys;
    setActiveDownloadKeys(nextActiveDownloadKeys);
    const timer = window.setTimeout(() => {
      const activeKeys = new Set(activeDownloadKeysRef.current);
      activeKeys.delete(downloadKey);
      activeDownloadKeysRef.current = activeKeys;
      setActiveDownloadKeys(activeKeys);
      downloadCooldownTimersRef.current.delete(downloadKey);
    }, MESSAGE_CARD_DOWNLOAD_START_COOLDOWN_MS);
    downloadCooldownTimersRef.current.set(downloadKey, timer);
    return true;
  }, []);
  useEffect(() => {
    return () => {
      for (const timer of downloadCooldownTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      downloadCooldownTimersRef.current.clear();
    };
  }, []);

  return { isDownloadStarting, onDownloadStart };
}

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

export function mediaAttachmentSizeBytes(m: MessageMediaInfo): number | null {
  const raw = m as MessageMediaInfoRaw;
  return m.sizeBytes ?? raw.size_bytes ?? null;
}

export function messageCardAttachmentsArchiveHref(messageId: number): string {
  return `/api/rer-importer/messages/${messageId}/attachments.zip`;
}

export function mediaDownloadAttr(displayName: string, fallbackName: string): string {
  return displayName === '<файл без назви>' ? fallbackName : displayName.replace(/[/\\]/g, '_');
}

export function canDownloadAllMessageAttachments(attachments: MessageMediaInfo[]): boolean {
  if (attachments.length <= 1 || attachments.length > RER_MESSAGE_ATTACHMENTS_ZIP_MAX_FILES) {
    return false;
  }
  const knownTotalBytes = attachments.reduce((totalBytes, attachment) => {
    const sizeBytes = mediaAttachmentSizeBytes(attachment);
    return typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > 0
      ? totalBytes + sizeBytes
      : totalBytes;
  }, 0);
  return knownTotalBytes <= RER_MESSAGE_ATTACHMENTS_ZIP_MAX_TOTAL_BYTES;
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

export function MessageMediaAudioPlayer({
  attachment,
  isDownloadStarting,
  onDownloadStart,
}: { attachment: MessageMediaInfo } & MessageCardDownloadGuardProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLElement | null>(null);
  const paletteMode = useMuiPaletteMode();
  const displayName = mediaAttachmentDisplayName(attachment);
  const transcription = attachment.transcription?.trim() ?? '';
  const { enabled: audioTranscriptionEnabled } = useAudioTranscriptionPreferences();
  const showTranscription = audioTranscriptionEnabled && transcription !== '';
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
    player.setAttribute('variant', 'echo');
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

  const downloadKey = messageCardMediaDownloadKey(String(attachment.id));
  const downloading = isDownloadStarting(downloadKey);
  const downloadAttr = mediaDownloadAttr(displayName, 'attachment');
  const downloadLabel = `Завантажити аудіо: ${displayName}`;
  const downloadAriaLabel = downloading ? 'Завантаження…' : downloadLabel;

  return (
    <div className={`w-full min-w-0${showTranscription ? ' audio-transcription-layout' : ''}`}>
      <div className="audio-player-row flex w-full min-w-0 items-stretch gap-2">
        <div
          ref={hostRef}
          className="relative z-0 flex w-full min-h-12 min-w-0 max-w-[460px] items-stretch overflow-hidden pb-1"
          data-audio-player-host
          data-audio-player-min-height-px={AUDIO_PLAYER_MIN_HEIGHT_PX}
          data-audio-player-top-padding-px={AUDIO_PLAYER_TOP_PADDING_PX}
          data-audio-player-z-index={AUDIO_PLAYER_Z_INDEX}
        />
        <Tooltip title={downloadLabel} enterDelay={400}>
          <MessageCardDisabledControlCursorWrapper
            className="self-stretch items-center"
            disabled={downloading}
          >
            <Button
              component="a"
              size="small"
              variant="outlined"
              href={href}
              download={downloadAttr}
              target="_blank"
              rel="noopener noreferrer"
              disabled={downloading}
              aria-busy={downloading}
              aria-label={downloadAriaLabel}
              onClick={(event) =>
                guardMessageCardDownloadClick(event, downloadKey, {
                  isDownloadStarting,
                  onDownloadStart,
                })
              }
              sx={{
                minWidth: 0,
                maxWidth: '100%',
                minHeight: 26,
                py: 0.25,
                px: 0.75,
                fontSize: 11,
                lineHeight: 1.25,
                textTransform: 'none',
                fontWeight: 500,
                color: 'text.primary',
                borderColor: 'divider',
                '&:hover': {
                  backgroundColor: 'action.hover',
                  borderColor: 'text.primary',
                },
                alignSelf: 'center',
                flexShrink: 0,
                '& .MuiButton-startIcon': {
                  mr: 0,
                  ml: 0,
                  '& svg': { fontSize: 14 },
                },
              }}
              startIcon={
                downloading ? (
                  <CircularProgress size={14} aria-label="Завантаження…" />
                ) : (
                  <DownloadIcon aria-hidden />
                )
              }
            />
          </MessageCardDisabledControlCursorWrapper>
        </Tooltip>
      </div>
      {showTranscription ? <MessageCardAudioTranscription transcription={transcription} /> : null}
    </div>
  );
}

export function MessageMediaDownloadLink({
  attachment,
  isDownloadStarting,
  onDownloadStart,
}: { attachment: MessageMediaInfo } & MessageCardDownloadGuardProps) {
  const displayName = mediaAttachmentDisplayName(attachment);
  const downloadKey = messageCardMediaDownloadKey(String(attachment.id));
  const downloading = isDownloadStarting(downloadKey);
  const downloadAttr = mediaDownloadAttr(displayName, 'attachment');
  return (
    <Tooltip title={displayName} enterDelay={400}>
      <MessageCardDisabledControlCursorWrapper disabled={downloading}>
        <Button
          component="a"
          size="small"
          variant="outlined"
          href={String(attachment.href ?? '')}
          download={downloadAttr}
          target="_blank"
          rel="noopener noreferrer"
          disabled={downloading}
          aria-busy={downloading}
          aria-label={downloading ? 'Завантаження…' : undefined}
          onClick={(event) =>
            guardMessageCardDownloadClick(event, downloadKey, {
              isDownloadStarting,
              onDownloadStart,
            })
          }
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
            color: 'text.primary',
            borderColor: 'divider',
            '&:hover': {
              backgroundColor: 'action.hover',
              borderColor: 'text.primary',
            },
            alignSelf: 'flex-start',
            overflow: 'hidden',
            justifyContent: 'flex-start',
            '& .MuiButton-startIcon': {
              mr: 0.35,
              ml: -0.25,
              '& svg': { fontSize: 14 },
            },
          }}
          startIcon={
            downloading ? (
              <CircularProgress size={14} aria-label="Завантаження…" />
            ) : (
              <DownloadOutlinedIcon aria-hidden />
            )
          }
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
      </MessageCardDisabledControlCursorWrapper>
    </Tooltip>
  );
}

export function MessageMediaDownloadAllLink({
  messageId,
  isDownloadStarting,
  onDownloadStart,
}: { messageId: number } & MessageCardDownloadGuardProps) {
  const downloadKey = MESSAGE_CARD_ATTACHMENTS_ARCHIVE_DOWNLOAD_KEY;
  const downloading = isDownloadStarting(downloadKey);
  return (
    <MessageCardDisabledControlCursorWrapper disabled={downloading}>
      <Button
        component="a"
        size="small"
        variant="outlined"
        href={messageCardAttachmentsArchiveHref(messageId)}
        download={MESSAGE_CARD_ATTACHMENTS_ARCHIVE_FILE_NAME}
        target="_blank"
        rel="noopener noreferrer"
        disabled={downloading}
        aria-busy={downloading}
        aria-label={downloading ? 'Завантаження…' : MESSAGE_CARD_ATTACHMENTS_ARCHIVE_LABEL}
        onClick={(event) =>
          guardMessageCardDownloadClick(event, downloadKey, {
            isDownloadStarting,
            onDownloadStart,
          })
        }
        sx={{
          minWidth: 0,
          maxWidth: '100%',
          minHeight: 26,
          py: 0.25,
          px: 0.75,
          fontSize: 11,
          lineHeight: 1.25,
          textTransform: 'none',
          fontWeight: 500,
          color: 'text.primary',
          borderColor: 'divider',
          '&:hover': {
            backgroundColor: 'action.hover',
            borderColor: 'text.primary',
          },
          alignSelf: 'center',
          flexShrink: 0,
          '& .MuiButton-startIcon': {
            mr: 0.35,
            ml: -0.25,
            '& svg': { fontSize: 14 },
          },
        }}
        startIcon={
          downloading ? (
            <CircularProgress size={14} aria-label="Завантаження…" />
          ) : (
            <DownloadIcon aria-hidden />
          )
        }
      >
        {downloading ? 'Завантаження…' : MESSAGE_CARD_ATTACHMENTS_ARCHIVE_LABEL}
      </Button>
    </MessageCardDisabledControlCursorWrapper>
  );
}

export function MessageMediaThumbnailDownloadLink({
  href,
  displayName,
  downloadName,
  downloadKey,
  isDownloadStarting,
  onDownloadStart,
}: {
  href: string;
  displayName: string;
  downloadName: string;
  downloadKey: string;
} & MessageCardDownloadGuardProps) {
  if (href.trim() === '') return null;

  const downloading = isDownloadStarting(downloadKey);
  const label = `Завантажити вкладення: ${displayName}`;
  return (
    <Tooltip title={label} enterDelay={400}>
      <MessageCardDisabledControlCursorWrapper disabled={downloading}>
        <IconButton
          component="a"
          href={href}
          download={downloadName}
          target="_blank"
          rel="noopener noreferrer"
          size="small"
          disabled={downloading}
          aria-busy={downloading}
          aria-label={downloading ? 'Завантаження…' : label}
          onClick={(event) => {
            event.stopPropagation();
            guardMessageCardDownloadClick(event, downloadKey, {
              isDownloadStarting,
              onDownloadStart,
            });
          }}
          sx={{
            position: 'absolute',
            top: 5,
            right: 5,
            zIndex: 3,
            width: 22,
            height: 22,
            color: 'rgba(255, 255, 255, 0.92)',
            backgroundColor: 'rgba(15, 23, 42, 0.42)',
            boxShadow: '0 1px 3px rgba(15, 23, 42, 0.28)',
            opacity: { xs: 0.78, sm: 0.62 },
            transition: 'opacity 120ms ease-out, background-color 120ms ease-out',
            '&:hover, &:focus-visible': {
              opacity: 0.95,
              backgroundColor: 'rgba(15, 23, 42, 0.64)',
            },
            '& svg': { fontSize: 15 },
          }}
        >
          {downloading ? (
            <CircularProgress size={12} aria-label="Завантаження…" />
          ) : (
            <DownloadIcon aria-hidden />
          )}
        </IconButton>
      </MessageCardDisabledControlCursorWrapper>
    </Tooltip>
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
