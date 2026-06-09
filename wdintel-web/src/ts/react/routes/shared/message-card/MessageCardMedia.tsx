import { useState } from 'react';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import { Box, Button, Tooltip } from '@mui/material';

import type { InboxMessage, MessageMediaInfo } from '../../../../../Bindings';

const PREVIEW_IMAGE_HEIGHT_PX = 100;

function isImageMediaAttachment(m: MessageMediaInfo): boolean {
  const ct = String(m.contentType ?? '').trim();
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

function mediaAttachmentDisplayName(m: MessageMediaInfo): string {
  const raw = m as MessageMediaInfo & { file_name?: string | null };
  const s = (m.fileName ?? raw.file_name ?? '').trim();
  if (s !== '') return s;
  return '<файл без назви>';
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
