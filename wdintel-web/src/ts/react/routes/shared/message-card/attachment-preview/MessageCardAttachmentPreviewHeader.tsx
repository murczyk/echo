import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import DownloadIcon from '@mui/icons-material/Download';
import InfoIcon from '@mui/icons-material/Info';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { Box, CircularProgress, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import type { MouseEvent, ReactNode } from 'react';

import type {
  AttachmentPreviewDownload,
  MessageCardPreviewNavigation,
} from './message-card-preview.types';
import { MessageCardDisabledControlCursorWrapper } from '../MessageCardDisabledControlCursorWrapper';

export function MessageCardAttachmentPreviewHeader({
  fileName,
  openHref,
  download,
  downloadKey,
  navigation,
  additionalActions,
  overflowAction,
  status,
  onInfoClick,
  infoSeverity,
  isFullscreen,
  canFullscreen,
  onToggleFullscreen,
  onClose,
  isDownloadStarting,
  onDownloadStart,
}: {
  fileName?: string | null;
  openHref?: string | null;
  download?: AttachmentPreviewDownload;
  downloadKey?: string;
  navigation: MessageCardPreviewNavigation;
  additionalActions?: ReactNode;
  overflowAction?: ReactNode;
  status?: ReactNode;
  onInfoClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  infoSeverity?: 'warning' | 'error';
  isFullscreen?: boolean;
  canFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  onClose: () => void;
  isDownloadStarting?: (downloadKey: string) => boolean;
  onDownloadStart?: (downloadKey: string) => boolean;
}) {
  const downloading =
    downloadKey != null && isDownloadStarting != null && isDownloadStarting(downloadKey);
  const hasCarousel = navigation.count > 1;

  const startDownload = (event: MouseEvent<HTMLButtonElement | HTMLAnchorElement>) => {
    if (
      downloadKey == null ||
      isDownloadStarting == null ||
      onDownloadStart == null ||
      isDownloadStarting(downloadKey) ||
      !onDownloadStart(downloadKey)
    ) {
      event.preventDefault();
      return false;
    }
    return true;
  };

  const iconButtonSx = {
    color: 'text.secondary',
    '&:hover': {
      color: 'text.primary',
      backgroundColor: 'action.hover',
    },
    '&.Mui-disabled': {
      color: 'action.disabled',
    },
  };

  const downloadButton =
    download == null ? null : 'href' in download && typeof download.href === 'string' ? (
      <IconButton
        component="a"
        href={download.href}
        download={download.fileName}
        aria-label={downloading ? 'Завантаження…' : 'Скачати'}
        aria-busy={downloading}
        disabled={downloading}
        onClick={startDownload}
        size="small"
        sx={iconButtonSx}
      >
        {downloading ? (
          <CircularProgress size={16} color="inherit" aria-label="Завантаження…" />
        ) : (
          <DownloadIcon fontSize="small" />
        )}
      </IconButton>
    ) : (
      <IconButton
        aria-label={downloading ? 'Завантаження…' : 'Скачати'}
        aria-busy={downloading}
        disabled={downloading}
        onClick={(event) => {
          if (startDownload(event)) download.onDownload();
        }}
        size="small"
        sx={iconButtonSx}
      >
        {downloading ? (
          <CircularProgress size={16} color="inherit" aria-label="Завантаження…" />
        ) : (
          <DownloadIcon fontSize="small" />
        )}
      </IconButton>
    );

  return (
    <Box
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 52,
        px: 2,
        py: 1,
        backgroundColor: 'background.paper',
        backdropFilter: 'blur(12px)',
        borderBottom: 1,
        borderColor: 'divider',
        color: 'text.primary',
        zIndex: 1400,
        flexShrink: 0,
      }}
    >
      {/* Left: File name + extension + Info button */}
      <Box sx={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 1, pr: 2 }}>
        {fileName ? (
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 600,
              fontSize: '0.9rem',
              color: 'text.primary',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: { xs: 180, sm: 260, md: 400 },
            }}
            title={fileName}
          >
            {fileName}
          </Typography>
        ) : null}
        {onInfoClick != null ? (
          <Tooltip title="Інформація" enterDelay={300}>
            <IconButton
              aria-label="Інформація"
              size="small"
              onClick={onInfoClick}
              sx={{
                ...iconButtonSx,
                color:
                  infoSeverity === 'error'
                    ? 'error.main'
                    : infoSeverity === 'warning'
                      ? 'warning.main'
                      : iconButtonSx.color,
                opacity: infoSeverity === 'error' ? 0.72 : infoSeverity === 'warning' ? 0.58 : 1,
                '&:hover': {
                  color: 'text.primary',
                  backgroundColor: 'action.hover',
                  opacity: 1,
                },
              }}
            >
              <InfoIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>

      {/* Center: Fixed Carousel Navigation & Counter (< 1 / 6 >) */}
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1,
          display: { xs: 'none', sm: 'flex' },
        }}
      >
        {hasCarousel ? (
          <Tooltip title="Попереднє" enterDelay={300}>
            <IconButton
              aria-label="Попереднє"
              size="small"
              onClick={navigation.onPrevious}
              sx={iconButtonSx}
              data-attachment-preview-nav="prev"
            >
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
        <Typography
          variant="caption"
          className="font-mono"
          data-attachment-preview-counter
          sx={{
            px: 1,
            py: 0.25,
            borderRadius: 1,
            backgroundColor: 'action.hover',
            color: 'text.primary',
            fontWeight: 700,
            fontSize: '0.75rem',
            whiteSpace: 'nowrap',
          }}
        >
          {`${navigation.index + 1} / ${navigation.count}`}
        </Typography>
        {hasCarousel ? (
          <Tooltip title="Наступне" enterDelay={300}>
            <IconButton
              aria-label="Наступне"
              size="small"
              onClick={navigation.onNext}
              sx={iconButtonSx}
              data-attachment-preview-nav="next"
            >
              <ChevronRightIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Stack>

      {/* Right: System actions: [Download] [Open in new tab] [Overflow] [Close (X)] */}
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexShrink: 0, zIndex: 2 }}>
        {status}
        {additionalActions}
        {downloadButton == null ? null : (
          <Tooltip title={downloading ? 'Завантаження…' : 'Скачати'} enterDelay={300}>
            <MessageCardDisabledControlCursorWrapper disabled={downloading}>
              {downloadButton}
            </MessageCardDisabledControlCursorWrapper>
          </Tooltip>
        )}
        {typeof openHref === 'string' && openHref.trim() !== '' ? (
          <Tooltip title="Відкрити в новій вкладці" enterDelay={300}>
            <IconButton
              component="a"
              href={openHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Відкрити в новій вкладці"
              size="small"
              sx={iconButtonSx}
            >
              <OpenInNewIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
        {overflowAction}
        {canFullscreen && onToggleFullscreen ? (
          <Tooltip
            title={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
            enterDelay={300}
          >
            <IconButton
              aria-label={isFullscreen ? 'Вийти з повноекранного режиму' : 'Повноекранний режим'}
              size="small"
              onClick={onToggleFullscreen}
              sx={iconButtonSx}
            >
              {isFullscreen ? (
                <FullscreenExitIcon fontSize="small" />
              ) : (
                <FullscreenIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip title="Закрити" enterDelay={300}>
          <IconButton aria-label="Закрити" size="small" onClick={onClose} sx={iconButtonSx}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Box>
  );
}
