import { useLayoutEffect, useRef, useState } from 'react';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import { Box, Button, Tooltip, Typography } from '@mui/material';

import type { InboxMessage, MessageMediaInfo } from '../../../../../Bindings';
import { getMuiPaletteMode, useMuiPaletteMode } from '../../../mui-theme';

const PREVIEW_IMAGE_HEIGHT_PX = 100;

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
};

export function mediaAttachmentContentType(m: MessageMediaInfo): string {
  const raw = m as MessageMediaInfoRaw;
  return String(m.contentType ?? raw.content_type ?? '')
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

export function collectMessageImageHrefs(msg: InboxMessage): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (href: string) => {
    if (seen.has(href)) return;
    seen.add(href);
    out.push(href);
  };
  for (const href of msg.images ?? []) add(href);
  for (const attachment of msg.media ?? []) {
    if (isImageMediaAttachment(attachment)) add(attachment.href);
  }
  return out;
}

export function MessagePictureThumb({ href }: { href: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) return null;

  return (
    <Box component="span" sx={{ display: 'inline-block', mr: 0.5, mb: 0.5, lineHeight: 0 }}>
      <Box component="a" href={href} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-block' }}>
        <Box
          component="img"
          src={href}
          alt=""
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          sx={{
            display: loaded ? 'block' : 'none',
            height: PREVIEW_IMAGE_HEIGHT_PX,
            minHeight: PREVIEW_IMAGE_HEIGHT_PX,
            width: 'auto',
            maxWidth: '100%',
            objectFit: 'contain',
            verticalAlign: 'middle',
          }}
        />
      </Box>
    </Box>
  );
}

export function isAudioMediaAttachment(m: MessageMediaInfo): boolean {
  const ct = mediaAttachmentContentType(m);
  if (ct.startsWith('video/')) return false;
  if (ct.startsWith('audio/')) return true;
  if (ct.includes('mpeg') || ct.includes('mp3')) return true;
  const fileName = mediaAttachmentDisplayName(m).toLowerCase();
  if (AUDIO_FILE_EXTENSIONS.some((ext) => fileName.endsWith(ext))) return true;
  const href = String(m.href ?? '').toLowerCase();
  return AUDIO_FILE_EXTENSION_RE.test(href);
}

function mediaAttachmentDisplayName(m: MessageMediaInfo): string {
  const raw = m as MessageMediaInfoRaw;
  const s = (m.fileName ?? raw.file_name ?? '').trim();
  if (s !== '') return s;
  return '<файл без назви>';
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
  const waveSrc = mediaId !== '' ? mediaAttachmentWaveUrl(mediaId) : '';
  const spectrumSrc = mediaId !== '' ? mediaAttachmentSpectrumUrl(mediaId) : '';
  const storageKey = `echo-inbox-${mediaId || displayName}`;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || href === '') return;

    const player = document.createElement('custom-audio-player');
    player.setAttribute('src', href);
    player.setAttribute('mode', 'compact');
    player.setAttribute('storage-key', storageKey);
    player.setAttribute('theme', getMuiPaletteMode());
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
  }, [href, storageKey, waveSrc, spectrumSrc]);

  useLayoutEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    syncAudioPlayerTheme(player, paletteMode);
  }, [paletteMode]);

  if (href === '') return null;

  return (
    <Box sx={{ mb: 0.5, width: '100%', maxWidth: 460, minWidth: 0 }}>
      <Typography
        variant="caption"
        component="div"
        title={displayName}
        sx={{
          mb: 0.25,
          color: 'text.secondary',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {displayName}
      </Typography>
      <Box ref={hostRef} sx={{ width: '100%', minWidth: 0 }} />
    </Box>
  );
}

export function MessageMediaDownloadLink({ attachment }: { attachment: MessageMediaInfo }) {
  const displayName = mediaAttachmentDisplayName(attachment);
  const downloadAttr = displayName === '<файл без назви>' ? 'attachment' : displayName.replace(/[/\\]/g, '_');
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
          '& .MuiButton-startIcon': { mr: 0.35, ml: -0.25, '& svg': { fontSize: 14 } },
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
