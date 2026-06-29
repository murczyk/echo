import { useState } from 'react';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import { Box, ButtonBase, Typography } from '@mui/material';

import type { MessageMediaInfo } from '../../../../../Bindings';
import { mediaAttachmentDisplayName } from './MessageCardMedia';

export function MessageCardVideoThumb({
  attachment,
  index,
  onOpen,
}: {
  attachment: MessageMediaInfo;
  index: number;
  onOpen: (index: number) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const href = String(attachment.href ?? '');
  const displayName = mediaAttachmentDisplayName(attachment);
  const canOpen = href.trim() !== '';

  return (
    <ButtonBase
      component="button"
      type="button"
      onClick={canOpen ? () => onOpen(index) : undefined}
      disabled={!canOpen}
      aria-label="Відкрити відео"
      sx={{
        display: 'inline-flex',
        width: 160,
        height: 120,
        alignSelf: 'flex-start',
        alignItems: 'stretch',
        justifyContent: 'stretch',
        textAlign: 'left',
        cursor: canOpen ? 'pointer' : 'default',
        color: 'inherit',
        borderRadius: 1.5,
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'divider',
        backgroundColor: 'action.hover',
        '&:disabled': {
          color: 'text.disabled',
        },
        '&:focus-visible': {
          outline: '2px solid',
          outlineColor: 'primary.main',
          outlineOffset: '-2px',
        },
      }}
    >
      <Box
        sx={{
          position: 'relative',
          display: 'flex',
          width: '100%',
          height: '100%',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          backgroundColor: 'rgba(255, 255, 255, 0.02)',
        }}
      >
        <Box
          component="video"
          src={href}
          preload="metadata"
          onLoadedMetadata={() => setLoaded(true)}
          sx={{
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            opacity: loaded ? 1 : 0,
            transition: 'opacity 120ms ease-out',
            pointerEvents: 'none',
          }}
        />
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: loaded ? 'rgba(0, 0, 0, 0.2)' : 'transparent',
            transition: 'background-color 120ms ease-out',
          }}
        >
          <PlayCircleOutlineIcon sx={{ fontSize: 40, color: 'rgba(255, 255, 255, 0.8)' }} />
          {!loaded && (
            <Typography
              variant="caption"
              sx={{
                mt: 1,
                px: 1,
                width: '100%',
                textAlign: 'center',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'text.secondary'
              }}
            >
              {displayName}
            </Typography>
          )}
        </Box>
      </Box>
    </ButtonBase>
  );
}
