import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { Box, ButtonBase, IconButton, Tooltip } from '@mui/material';
import type { Dispatch, SetStateAction } from 'react';

import {
  clamp,
  DOCUMENT_PREVIEW_ZOOM_MAX,
  DOCUMENT_PREVIEW_ZOOM_MIN,
  DOCUMENT_PREVIEW_ZOOM_STEP,
} from '../document-preview-utils';

export function DocumentPreviewZoomControls({
  zoom,
  onZoomChange,
}: {
  zoom: number;
  onZoomChange: Dispatch<SetStateAction<number>>;
}) {
  const changeZoom = (delta: number) => {
    onZoomChange((currentZoom) =>
      clamp(currentZoom + delta, DOCUMENT_PREVIEW_ZOOM_MIN, DOCUMENT_PREVIEW_ZOOM_MAX),
    );
  };

  return (
    <Box
      role="group"
      aria-label="Масштаб документа"
      data-document-preview-zoom-controls
      sx={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        zIndex: 1300,
        display: 'flex',
        alignItems: 'center',
        backgroundColor: 'background.paper',
        backdropFilter: 'blur(12px)',
        color: 'text.primary',
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
      }}
    >
      <Tooltip title="Зменшити масштаб" disableInteractive>
        <span>
          <IconButton
            size="small"
            aria-label="Зменшити масштаб"
            disabled={zoom <= DOCUMENT_PREVIEW_ZOOM_MIN}
            onClick={() => changeZoom(-DOCUMENT_PREVIEW_ZOOM_STEP)}
          >
            <RemoveIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="Скинути масштаб (100%)" disableInteractive>
        <ButtonBase
          aria-label="Скинути масштаб (100%)"
          onClick={() => onZoomChange(100)}
          sx={{
            gap: 0.5,
            px: 1,
            py: 0.5,
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'monospace',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {Math.round(zoom)}%
          {Math.round(zoom) !== 100 ? <RestartAltIcon sx={{ fontSize: 16 }} /> : null}
        </ButtonBase>
      </Tooltip>
      <Tooltip title="Збільшити масштаб" disableInteractive>
        <span>
          <IconButton
            size="small"
            aria-label="Збільшити масштаб"
            disabled={zoom >= DOCUMENT_PREVIEW_ZOOM_MAX}
            onClick={() => changeZoom(DOCUMENT_PREVIEW_ZOOM_STEP)}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}
