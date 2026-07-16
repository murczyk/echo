import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DownloadIcon from '@mui/icons-material/Download';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import InfoIcon from '@mui/icons-material/Info';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import {
  Box,
  Button,
  DialogActions,
  IconButton,
  Slider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import type { MouseEvent } from 'react';
import { useTheme } from '@mui/material/styles';

import { ZOOM_MAX, ZOOM_MARKS, ZOOM_MIN, ZOOM_STEP } from './message-card-image-preview-utils';
import { getMessageCardPreviewActionBarSx } from './message-card-preview-shell';

export function MessageCardImagePreviewControls({
  zoom,
  isFullscreen,
  canFullscreen,
  onSetPreviewZoom,
  onToggleFullscreen,
}: {
  zoom: number;
  isFullscreen: boolean;
  canFullscreen: boolean;
  onSetPreviewZoom: (zoom: number) => void;
  onToggleFullscreen: () => void;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        flex: 1,
        minWidth: 0,
        backgroundColor: 'background.paper',
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
            sx={{ color: 'text.secondary' }}
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
        onChange={(_, value) => {
          const nextZoom = Array.isArray(value) ? (value[0] ?? ZOOM_MIN) : value;
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
            sx={{ color: 'text.secondary' }}
          >
            <ZoomInIcon />
          </IconButton>
        </span>
      </Tooltip>

      <Typography
        variant="caption"
        className="font-mono"
        sx={{
          color: 'text.secondary',
          minWidth: 44,
          textAlign: 'center',

          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {Math.round(zoom)}%
      </Typography>

      {canFullscreen ? (
        <Box sx={{ ml: { xs: 0, sm: 1 } }}>
          <Tooltip
            title={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
            enterDelay={300}
          >
            <IconButton
              aria-label={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
              size="small"
              onClick={onToggleFullscreen}
              sx={{ color: 'text.secondary' }}
            >
              {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
            </IconButton>
          </Tooltip>
        </Box>
      ) : null}
    </Box>
  );
}

export function MessageCardImagePreviewActions({
  currentHref,
  downloadFileName,
  hasCarousel,
  copyStatus,
  canCopyImage,
  resolvedIndex,
  imageCount,
  onCopyImage,
  onGoToPrevious,
  onGoToNext,
  onInfoClick,
  onClose,
}: {
  currentHref: string;
  downloadFileName: string;
  hasCarousel: boolean;
  copyStatus: 'idle' | 'copying' | 'copied' | 'error';
  canCopyImage: boolean;
  resolvedIndex: number;
  imageCount: number;
  onCopyImage: () => void;
  onGoToPrevious: () => void;
  onGoToNext: () => void;
  onInfoClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onClose: () => void;
}) {
  const copyTooltip =
    copyStatus === 'copying'
      ? 'Копіювання...'
      : canCopyImage
        ? 'Скопіювати зображення'
        : 'Копіювання зображень недоступне';
  const copyLabel =
    copyStatus === 'copying'
      ? 'Копіювання...'
      : copyStatus === 'copied'
        ? 'Зображення скопійовано'
        : copyStatus === 'error'
          ? 'Не вдалося скопіювати зображення'
          : '';
  const copyLabelColor =
    copyStatus === 'copied'
      ? 'success.main'
      : copyStatus === 'error'
        ? 'error.main'
        : 'text.secondary';

  return (
    <DialogActions
      sx={{
        px: 2,
        py: '20px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 2,
      }}
    >
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          justifyContent: 'flex-start',
          gap: 0.5,
        }}
      >
        <Tooltip title="Інформація" enterDelay={300}>
          <IconButton
            aria-label="Інформація"
            size="small"
            onClick={onInfoClick}
            sx={{ color: 'text.secondary' }}
          >
            <InfoIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title={copyTooltip} enterDelay={300}>
          <span>
            <IconButton
              aria-label="Скопіювати зображення"
              size="small"
              onClick={onCopyImage}
              disabled={!canCopyImage || copyStatus === 'copying'}
              sx={{ color: 'text.secondary' }}
            >
              <ContentCopyIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Відкрити в новій вкладці" enterDelay={300}>
          <IconButton
            component="a"
            href={currentHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Відкрити в новій вкладці"
            size="small"
            sx={{ color: 'text.secondary' }}
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
            sx={{ color: 'text.secondary' }}
          >
            <DownloadIcon />
          </IconButton>
        </Tooltip>
        {copyLabel !== '' ? (
          <Typography
            variant="caption"
            aria-live="polite"
            sx={{
              alignSelf: 'center',
              ml: 0.75,
              color: copyLabelColor,
              whiteSpace: 'nowrap',
            }}
          >
            {copyLabel}
          </Typography>
        ) : null}
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        {hasCarousel && (
          <Tooltip title="Попереднє" enterDelay={300}>
            <IconButton
              aria-label="Попереднє"
              size="small"
              onClick={onGoToPrevious}
              sx={{ color: 'text.secondary' }}
              data-image-preview-nav="prev"
            >
              <ChevronLeftIcon />
            </IconButton>
          </Tooltip>
        )}
        <Typography
          variant="body2"
          data-image-preview-counter
          sx={{
            backgroundColor: 'action.hover',
            color: 'text.primary',
            fontWeight: 700,
            letterSpacing: 0,
            px: 1,
            py: 0.25,
            borderRadius: 1,
            whiteSpace: 'nowrap',
          }}
        >
          {`${resolvedIndex + 1} / ${imageCount}`}
        </Typography>
        {hasCarousel && (
          <Tooltip title="Наступне" enterDelay={300}>
            <IconButton
              aria-label="Наступне"
              size="small"
              onClick={onGoToNext}
              sx={{ color: 'text.secondary' }}
              data-image-preview-nav="next"
            >
              <ChevronRightIcon />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      <Box sx={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={onClose} sx={{ flexShrink: 0, ml: 1 }}>
          Закрити
        </Button>
      </Box>
    </DialogActions>
  );
}
