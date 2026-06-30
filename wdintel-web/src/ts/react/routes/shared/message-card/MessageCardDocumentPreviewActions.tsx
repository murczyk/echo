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

import { DOCUMENT_PREVIEW_ZOOM_MAX, DOCUMENT_PREVIEW_ZOOM_MARKS, DOCUMENT_PREVIEW_ZOOM_MIN, DOCUMENT_PREVIEW_ZOOM_STEP } from './document-preview-utils';
import { getMessageCardPreviewActionBarSx } from './message-card-preview-shell';

export function MessageCardDocumentPreviewControls({
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
        backgroundColor: "#121212",
        py: 1.5,
        px: 3,
      }}
    >
      <Tooltip title="Зменшити" enterDelay={300}>
        <span>
          <IconButton
            aria-label="Зменшити"
            size="small"
            onClick={() => onSetPreviewZoom(zoom - DOCUMENT_PREVIEW_ZOOM_STEP)}
            disabled={zoom <= DOCUMENT_PREVIEW_ZOOM_MIN}
            className="text-white/80"
          >
            <ZoomOutIcon />
          </IconButton>
        </span>
      </Tooltip>
      <Slider
        size="small"
        value={zoom}
        min={DOCUMENT_PREVIEW_ZOOM_MIN}
        max={DOCUMENT_PREVIEW_ZOOM_MAX}
        step={DOCUMENT_PREVIEW_ZOOM_STEP}
        marks={DOCUMENT_PREVIEW_ZOOM_MARKS.map(m => ({ value: m.value }))}
        aria-label="Масштаб"
        className="[&_.MuiSlider-thumb::before]:shadow-md [&_.MuiSlider-thumb::before]:shadow-black/40 hover:[&_.MuiSlider-thumb]:ring-8 hover:[&_.MuiSlider-thumb]:ring-white/15 [&_.MuiSlider-thumb.Mui-focusVisible]:ring-8 [&_.MuiSlider-thumb.Mui-focusVisible]:ring-white/15"
        onChange={(_, value) => {
          const nextZoom = Array.isArray(value) ? value[0] ?? DOCUMENT_PREVIEW_ZOOM_MIN : value;
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
            onClick={() => onSetPreviewZoom(zoom + DOCUMENT_PREVIEW_ZOOM_STEP)}
            disabled={zoom >= DOCUMENT_PREVIEW_ZOOM_MAX}
            className="text-white/80"
          >
            <ZoomInIcon />
          </IconButton>
        </span>
      </Tooltip>

      <Typography
        variant="caption"
        className="font-mono text-white/75"
        sx={{
          minWidth: 44,
          textAlign: 'center',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {Math.round(zoom)}%
      </Typography>

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
  );
}

export function MessageCardDocumentPreviewActions({
  currentHref,
  downloadFileName,
  hasCarousel,
  resolvedIndex,
  documentCount,
  onGoToPrevious,
  onGoToNext,
  onInfoClick,
  onClose,
}: {
  currentHref: string;
  downloadFileName: string;
  hasCarousel: boolean;
  resolvedIndex: number;
  documentCount: number;
  onGoToPrevious: () => void;
  onGoToNext: () => void;
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

      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        justifyContent="center"
        sx={{ justifySelf: 'center', minWidth: 0 }}
      >
        {hasCarousel && (
          <>
            <Tooltip title="Попереднє" enterDelay={300}>
              <IconButton
                size="small"
                onClick={onGoToPrevious}
                sx={{ color: 'inherit' }}
              >
                <ChevronLeftIcon />
              </IconButton>
            </Tooltip>
            <Typography
              variant="caption"
              className="font-mono bg-white/5"
              sx={{
                px: 1,
                py: 0.25,
                borderRadius: 1,
              }}
            >
              {`${resolvedIndex + 1} / ${documentCount}`}
            </Typography>
            <Tooltip title="Наступне" enterDelay={300}>
              <IconButton
                size="small"
                onClick={onGoToNext}
                sx={{ color: 'inherit' }}
              >
                <ChevronRightIcon />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Stack>

      <Stack direction="row" justifyContent="flex-end" sx={{ justifySelf: 'end' }}>
        <Button aria-label="Закрити" onClick={onClose}>
          Закрити
        </Button>
      </Stack>
    </DialogActions>
  );
}
