import DownloadIcon from '@mui/icons-material/Download';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import InfoIcon from '@mui/icons-material/Info';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import { Box, Button, DialogActions, IconButton, Slider, Stack, Tooltip, Typography } from '@mui/material';
import type { MouseEvent } from 'react';
import { useTheme } from '@mui/material/styles';

import { ZOOM_MAX, ZOOM_MARKS, ZOOM_MIN, ZOOM_STEP } from './message-card-image-preview-utils';
import { getMessageCardPreviewActionBarSx } from './message-card-preview-shell';

export function MessageCardImagePreviewControls({
  zoom,
  isFullscreen,
  onSetPreviewZoom,
  onToggleFullscreen,
}: {
  zoom: number;
  isFullscreen: boolean;
  onSetPreviewZoom: (zoom: number) => void;
  onToggleFullscreen: () => void;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 1.5,
        flex: 1,
        minWidth: 0,
        backgroundColor: "black",
        py: 1.5,
        px: 3,
      }}
    >
      <Tooltip title="Зменшити" enterDelay={300}>
        <span>
          <IconButton
            aria-label="Зменшити"
            size="small"
            onClick={() => onSetPreviewZoom(zoom - ZOOM_STEP)}
            disabled={zoom <= ZOOM_MIN}
            className="text-white/80"
          >
            <ZoomOutIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Slider
        size="small"
        value={zoom}
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={ZOOM_STEP}
        marks={ZOOM_MARKS.map((m) => ({ value: m.value }))}
        aria-label="Масштаб"
        className="[&_.MuiSlider-thumb::before]:shadow-md [&_.MuiSlider-thumb::before]:shadow-black/40 hover:[&_.MuiSlider-thumb]:ring-8 hover:[&_.MuiSlider-thumb]:ring-white/15 [&_.MuiSlider-thumb.Mui-focusVisible]:ring-8 [&_.MuiSlider-thumb.Mui-focusVisible]:ring-white/15"
        onChange={(_, value) => {
          const nextZoom = Array.isArray(value) ? value[0] ?? ZOOM_MIN : value;
          onSetPreviewZoom(nextZoom);
        }}
        sx={{
          width: { xs: 180, sm: 260 },
          color: 'primary.main',
          padding: 0,
          height: 4,
          '& .MuiSlider-track': {
            border: 'none',
          },
          '& .MuiSlider-thumb': {
            width: 12,
            height: 12,
            '&.Mui-active': {
              width: 16,
              height: 16,
            },
          },
          '& .MuiSlider-rail': {
            opacity: 0.28,
          },
          '& .MuiSlider-mark': {
            width: 2,
            height: 4,
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
            className="text-white/80"
          >
            <ZoomInIcon />
          </IconButton>
        </span>
      </Tooltip>

      <Box sx={{ ml: { xs: 0, sm: 1 } }}>
        <Tooltip title={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'} enterDelay={300}>
          <IconButton
            aria-label={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
            size="small"
            onClick={onToggleFullscreen}
            className="text-white/80"
          >
            {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}

export function MessageCardImagePreviewActions({
  currentHref,
  downloadFileName,
  hasCarousel,
  resolvedIndex,
  imageCount,
  onGoToPrevious,
  onGoToNext,
  onInfoClick,
  onClose,
}: {
  currentHref: string;
  downloadFileName: string;
  hasCarousel: boolean;
  resolvedIndex: number;
  imageCount: number;
  onGoToPrevious: () => void;
  onGoToNext: () => void;
  onInfoClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onClose: () => void;
}) {
  return (
    <DialogActions
      sx={{
        px: 2,
        py: "20px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 2,
      }}
    >
      <Box sx={{ flex: 1, display: "flex", justifyContent: "flex-start", gap: 0.5 }}>
        <Tooltip title="Інформація" enterDelay={300}>
          <IconButton aria-label="Інформація" size="small" onClick={onInfoClick} className="text-white/75">
            <InfoIcon />
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
            className="text-white/75"
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
            className="text-white/75"
          >
            <DownloadIcon />
          </IconButton>
        </Tooltip>
      </Box>
      {hasCarousel && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Tooltip title="Попереднє" enterDelay={300}>
            <IconButton
              size="small"
              onClick={onGoToPrevious}
              className="text-white/75"
            >
              <ChevronLeftIcon />
            </IconButton>
          </Tooltip>
          <Typography
            variant="body2"
            className="text-white/75 border border-white/10 bg-white/10"
            sx={{
              fontWeight: 700,
              letterSpacing: 0,
              px: 1,
              py: 0.25,
              borderRadius: 1,
            }}
          >
            {`${resolvedIndex + 1} / ${imageCount}`}
          </Typography>
          <Tooltip title="Наступне" enterDelay={300}>
            <IconButton
              size="small"
              onClick={onGoToNext}
              className="text-white/75"
            >
              <ChevronRightIcon />
            </IconButton>
          </Tooltip>
        </Box>
      )}
      <Box sx={{ flex: 1, display: "flex", justifyContent: "flex-end" }}>
        <Button onClick={onClose} sx={{ flexShrink: 0, ml: 1 }}>
          Закрити
        </Button>
      </Box>
    </DialogActions>
  );
}
