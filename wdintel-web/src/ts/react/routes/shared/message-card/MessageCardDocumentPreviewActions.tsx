import DownloadIcon from '@mui/icons-material/Download';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import InfoIcon from '@mui/icons-material/Info';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { Button, DialogActions, IconButton, Slider, Stack, Tooltip } from '@mui/material';
import type { MouseEvent } from 'react';

import { DOCUMENT_PREVIEW_ZOOM_MAX, DOCUMENT_PREVIEW_ZOOM_MARKS, DOCUMENT_PREVIEW_ZOOM_MIN, DOCUMENT_PREVIEW_ZOOM_STEP } from './document-preview-utils';

export function MessageCardDocumentPreviewActions({
  zoom,
  currentHref,
  downloadFileName,
  isFullscreen,
  onSetPreviewZoom,
  onToggleFullscreen,
  onInfoClick,
  onClose,
}: {
  zoom: number;
  currentHref: string;
  downloadFileName: string;
  isFullscreen: boolean;
  onSetPreviewZoom: (zoom: number) => void;
  onToggleFullscreen: () => void;
  onInfoClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onClose: () => void;
}) {
  return (
    <DialogActions
      sx={{
        px: 2,
        py: '28px',
        borderTop: '1px solid',
        borderColor: 'rgba(244, 247, 251, 0.12)',
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        gap: 1,
      }}
    >
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ justifySelf: 'start', minWidth: 0, flexWrap: 'wrap' }}>
        <Tooltip title="Інформація" enterDelay={300}>
          <IconButton aria-label="Інформація" size="small" onClick={onInfoClick} sx={{ color: 'inherit' }}>
            <InfoIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'} enterDelay={300}>
          <IconButton
            aria-label={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
            size="small"
            onClick={onToggleFullscreen}
            sx={{ color: 'inherit' }}
          >
            {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Відкрити в новій вкладці" enterDelay={300}>
          <IconButton
            component="a"
            href={currentHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Відкрити в новій вкладці"
            size="small"
            sx={{ color: 'inherit' }}
          >
            <OpenInNewIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Завантажити" enterDelay={300}>
          <IconButton
            component="a"
            href={currentHref}
            download={downloadFileName}
            aria-label="Завантажити"
            size="small"
            sx={{ color: 'inherit' }}
          >
            <DownloadIcon />
          </IconButton>
        </Tooltip>
      </Stack>
      <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="center" sx={{ justifySelf: 'center', minWidth: 0 }}>
        <Tooltip title="Зменшити" enterDelay={300}>
          <span>
            <IconButton
              aria-label="Зменшити"
              size="small"
              onClick={() => onSetPreviewZoom(zoom - DOCUMENT_PREVIEW_ZOOM_STEP)}
              disabled={zoom <= DOCUMENT_PREVIEW_ZOOM_MIN}
              sx={{ color: 'inherit' }}
            >
              <ZoomOutIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Slider
          value={zoom}
          min={DOCUMENT_PREVIEW_ZOOM_MIN}
          max={DOCUMENT_PREVIEW_ZOOM_MAX}
          step={DOCUMENT_PREVIEW_ZOOM_STEP}
          marks={DOCUMENT_PREVIEW_ZOOM_MARKS}
          valueLabelDisplay="auto"
          aria-label="Масштаб"
          onChange={(_, value) => {
            const nextZoom = Array.isArray(value) ? value[0] ?? DOCUMENT_PREVIEW_ZOOM_MIN : value;
            onSetPreviewZoom(nextZoom);
          }}
          sx={{
            width: { xs: 180, sm: 260 },
            color: 'primary.light',
            '& .MuiSlider-markLabel': {
              color: 'rgba(244, 247, 251, 0.68)',
            },
          }}
        />
        <Tooltip title="Збільшити" enterDelay={300}>
          <span>
            <IconButton
              aria-label="Збільшити"
              size="small"
              onClick={() => onSetPreviewZoom(zoom + DOCUMENT_PREVIEW_ZOOM_STEP)}
              disabled={zoom >= DOCUMENT_PREVIEW_ZOOM_MAX}
              sx={{ color: 'inherit' }}
            >
              <ZoomInIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Stack direction="row" justifyContent="flex-end" sx={{ justifySelf: 'end' }}>
        <Button aria-label="Закрити" onClick={onClose}>
          Закрити
        </Button>
      </Stack>
    </DialogActions>
  );
}
