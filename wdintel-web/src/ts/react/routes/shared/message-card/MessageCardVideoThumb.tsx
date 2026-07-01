import { useState } from 'react';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { Box, ButtonBase, Typography, Skeleton } from '@mui/material';

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
        maxWidth: 150,
        height: 150,
        minWidth: 85,
        alignSelf: 'flex-start',
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
        }}
      >
        {!loaded && (
          <Skeleton
            variant="rectangular"
            animation="wave"
            sx={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              zIndex: 0,
            }}
          />
        )}
        <Box
          component="video"
          src={href}
          preload="metadata"
          onLoadedMetadata={() => setLoaded(true)}
          sx={{
            display: 'block',
            maxWidth: 150,
            height: 150,
            width: 'auto',
            objectFit: 'cover',
            opacity: loaded ? 1 : 0,
            transition: 'opacity 120ms ease-out',
            pointerEvents: 'none',
          }}
        />
        <Box
          sx={{
            backgroundColor: 'transparent',
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background-color 120ms ease-out',
          }}
        >
          {loaded ? (
            <PlayArrowIcon sx={{ fontSize: 32, color: '#fff', filter: 'drop-shadow(0px 2px 4px rgba(0,0,0,0.5))' }} />
          ) : (
            <>
              <Typography
                variant="caption"
                sx={{
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
            </>
          )}
        </Box>
      </Box>
    </ButtonBase>
  );
}
