import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import InfoIcon from '@mui/icons-material/Info';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  Box,
  CircularProgress,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState, type MouseEvent, type ReactNode } from 'react';

import type { MessageCardPreviewNavigation } from './message-card-preview.types';
import { MessageCardDisabledControlCursorWrapper } from '../MessageCardDisabledControlCursorWrapper';

export type AttachmentPreviewDownload =
  | { href: string; fileName: string; onDownload?: never }
  | { href?: never; fileName?: never; onDownload: () => void };

export type AttachmentPreviewDownloadItem = {
  label: string;
  download: AttachmentPreviewDownload;
  downloadKey?: string;
};

export function MessageCardAttachmentPreviewHeader({
  fileName,
  openHref,
  download,
  downloadItems,
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
  downloadItems?: AttachmentPreviewDownloadItem[];
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
  const [downloadAnchorEl, setDownloadAnchorEl] = useState<HTMLElement | null>(null);
  const options =
    download == null
      ? []
      : [{ label: 'Скачати оригінал', download, downloadKey }, ...(downloadItems ?? [])];
  const downloading = options.some(
    (item) =>
      item.downloadKey != null &&
      isDownloadStarting != null &&
      isDownloadStarting(item.downloadKey),
  );
  const hasCarousel = navigation.count > 1;

  const startDownload = (event: MouseEvent<HTMLElement>, option: AttachmentPreviewDownloadItem) => {
    const key = option.downloadKey;
    if (
      key == null ||
      isDownloadStarting == null ||
      onDownloadStart == null ||
      isDownloadStarting(key) ||
      !onDownloadStart(key)
    ) {
      event.preventDefault();
      return false;
    }
    setDownloadAnchorEl(null);
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
    options.length === 0 ? null : (
      <>
        <IconButton
          aria-label={downloading ? 'Завантаження…' : 'Скачати'}
          aria-busy={downloading}
          disabled={downloading}
          onClick={(event) => setDownloadAnchorEl(event.currentTarget)}
          size="small"
          sx={iconButtonSx}
        >
          {downloading ? (
            <CircularProgress size={16} color="inherit" aria-label="Завантаження…" />
          ) : (
            <DownloadIcon fontSize="small" />
          )}
        </IconButton>
        <Menu
          anchorEl={downloadAnchorEl}
          open={downloadAnchorEl !== null}
          onClose={() => setDownloadAnchorEl(null)}
        >
          {options.map((option) => {
            const optionDownload = option.download;
            const key = `${option.label}:${option.downloadKey ?? ''}`;
            return 'href' in optionDownload && typeof optionDownload.href === 'string' ? (
              <MenuItem
                key={key}
                component="a"
                href={optionDownload.href}
                download={optionDownload.fileName}
                onClick={(event) => startDownload(event, option)}
              >
                {option.label}
              </MenuItem>
            ) : (
              <MenuItem
                key={key}
                onClick={(event) => {
                  if (startDownload(event, option)) optionDownload.onDownload();
                }}
              >
                {option.label}
              </MenuItem>
            );
          })}
        </Menu>
      </>
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
      {/* Left: File name + extension */}
      <Box sx={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', pr: 2 }}>
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

      {/* Right: System actions: [Info] [Download] [Open in new tab] [Overflow] [Full screen] [Close (X)] */}
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexShrink: 0, zIndex: 2 }}>
        {status}
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
              sx={{
                ...iconButtonSx,
                display: { xs: 'none', sm: 'inline-flex' },
              }}
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
