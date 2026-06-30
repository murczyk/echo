import DownloadIcon from '@mui/icons-material/Download';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import InfoIcon from '@mui/icons-material/Info';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { Button, DialogActions, IconButton, Slider, Stack, Tooltip } from '@mui/material';
import type { MouseEvent } from 'react';
import { useTheme } from '@mui/material/styles';

import { ZOOM_MAX, ZOOM_MARKS, ZOOM_MIN, ZOOM_STEP } from './message-card-image-preview-utils';
import { getMessageCardPreviewActionBarSx } from './message-card-preview-shell';

export function MessageCardImagePreviewActions({
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
  const theme = useTheme();
  return (
    <DialogActions sx={getMessageCardPreviewActionBarSx(theme)}>
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
              onClick={() => onSetPreviewZoom(zoom - ZOOM_STEP)}
              disabled={zoom <= ZOOM_MIN}
              sx={{ color: 'inherit' }}
            >
              <ZoomOutIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Slider
          value={zoom}
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          marks={ZOOM_MARKS}
          valueLabelDisplay="auto"
          aria-label="Масштаб"
          onChange={(_, value) => {
            const nextZoom = Array.isArray(value) ? value[0] ?? ZOOM_MIN : value;
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
              onClick={() => onSetPreviewZoom(zoom + ZOOM_STEP)}
              disabled={zoom >= ZOOM_MAX}
              sx={{ color: 'inherit' }}
            >
              <ZoomInIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Stack direction="row" justifyContent="flex-end" sx={{ justifySelf: 'end' }}>
        <Button onClick={onClose}>Закрити</Button>
      </Stack>
    </DialogActions>
  );
}
