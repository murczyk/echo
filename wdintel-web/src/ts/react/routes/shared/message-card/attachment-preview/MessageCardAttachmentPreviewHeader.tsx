import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import InfoIcon from '@mui/icons-material/Info';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  Box,
  CircularProgress,
  IconButton,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

import type {
  AttachmentPreviewDownload,
  AttachmentPreviewDownloadItem,
  MessageCardPreviewNavigation,
} from './message-card-preview.types';
import { MessageCardDisabledControlCursorWrapper } from '../MessageCardDisabledControlCursorWrapper';
import { PowerMenu } from '../../../../components/PowerMenu';

export const attachmentPreviewHeaderIconButtonSx = {
  color: 'text.secondary',
  '&:hover': {
    color: 'text.primary',
    backgroundColor: 'action.hover',
  },
  '&.Mui-disabled': {
    color: 'action.disabled',
  },
};

export function MessageCardAttachmentPreviewHeader({
  fileName,
  titleContent,
  titleId,
  openHref,
  download,
  downloadKey,
  downloadItems,
  navigation,
  additionalActions,
  overflowAction,
  status,
  onInfoClick,
  infoSeverity,
  onClose,
  closeLabel = 'Закрити',
  embedded = false,
  isDownloadStarting,
  onDownloadStart,
  onChildOverlayChange,
  dismissChildOverlay,
}: {
  fileName?: string | null;
  titleContent?: ReactNode;
  titleId?: string;
  openHref?: string | null;
  download?: AttachmentPreviewDownload;
  downloadKey?: string;
  downloadItems?: AttachmentPreviewDownloadItem[];
  navigation?: MessageCardPreviewNavigation;
  additionalActions?: ReactNode;
  overflowAction?: ReactNode;
  status?: ReactNode;
  onInfoClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  infoSeverity?: 'warning' | 'error';
  onClose?: () => void;
  closeLabel?: string;
  embedded?: boolean;
  isDownloadStarting?: (downloadKey: string) => boolean;
  onDownloadStart?: (downloadKey: string) => boolean;
  onChildOverlayChange?: (open: boolean) => void;
  dismissChildOverlay?: number;
}) {
  const [downloadMenuAnchor, setDownloadMenuAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    onChildOverlayChange?.(downloadMenuAnchor != null);
    return () => onChildOverlayChange?.(false);
  }, [downloadMenuAnchor, onChildOverlayChange]);
  useEffect(() => {
    if (dismissChildOverlay) setDownloadMenuAnchor(null);
  }, [dismissChildOverlay]);
  const choices =
    downloadItems ??
    (download == null || downloadKey == null
      ? []
      : [{ label: 'Завантажити', download, downloadKey }]);
  const hasDownloadChoices = downloadItems != null && choices.length > 0;
  const downloading =
    !hasDownloadChoices &&
    downloadKey != null &&
    isDownloadStarting != null &&
    isDownloadStarting(downloadKey);
  const hasCarousel = navigation != null && navigation.count > 1;

  const startDownload = (event: MouseEvent<HTMLElement>, key = downloadKey) => {
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
    return true;
  };

  const iconButtonSx = attachmentPreviewHeaderIconButtonSx;

  const downloadButton = hasDownloadChoices ? (
    <IconButton
      aria-label="Скачати"
      aria-expanded={downloadMenuAnchor != null}
      aria-haspopup="menu"
      onClick={(event) => setDownloadMenuAnchor(event.currentTarget)}
      size="small"
      sx={iconButtonSx}
    >
      <DownloadIcon fontSize="small" />
    </IconButton>
  ) : download == null ? null : 'href' in download && typeof download.href === 'string' ? (
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
      className={
        embedded && navigation
          ? '@min-[640px]/device-preview:grid! @min-[640px]/device-preview:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]'
          : undefined
      }
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
        zIndex: embedded ? 'auto' : 1400,
        flexShrink: 0,
      }}
    >
      {/* Left: File name + extension + Info button */}
      <Box sx={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 1, pr: 2 }}>
        {titleContent != null ? (
          <Typography
            component="div"
            id={titleId}
            variant="subtitle2"
            sx={{ minWidth: 0, fontWeight: 600, fontSize: '0.9rem', color: 'text.primary' }}
          >
            {titleContent}
          </Typography>
        ) : fileName ? (
          <Typography
            id={titleId}
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
      {navigation ? (
        <Stack
          data-attachment-preview-header-navigation
          className={embedded ? '@max-[640px]/device-preview:hidden!' : undefined}
          direction="row"
          spacing={0.5}
          alignItems="center"
          sx={{
            position: embedded ? 'static' : 'absolute',
            left: embedded ? undefined : '50%',
            transform: embedded ? undefined : 'translateX(-50%)',
            zIndex: 1,
            display: embedded ? 'flex' : { xs: 'none', sm: 'flex' },
            flexShrink: 0,
          }}
        >
          {hasCarousel ? (
            <Tooltip title="Попереднє" enterDelay={300}>
              <IconButton
                aria-label="Попереднє"
                size="small"
                onClick={navigation.onPrevious}
                disabled={navigation.disabled || navigation.previousDisabled}
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
                disabled={navigation.disabled || navigation.nextDisabled}
                sx={iconButtonSx}
                data-attachment-preview-nav="next"
              >
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : null}
        </Stack>
      ) : null}

      {/* Right: System actions: [Download] [Open in new tab] [Overflow] [Close (X)] */}
      <Stack
        direction="row"
        spacing={0.75}
        alignItems="center"
        sx={{ flexShrink: 0, zIndex: 2, justifySelf: 'end' }}
      >
        {status}
        {additionalActions}
        {downloadButton == null ? null : (
          <Tooltip title={downloading ? 'Завантаження…' : 'Скачати'} enterDelay={300}>
            <MessageCardDisabledControlCursorWrapper disabled={downloading}>
              {downloadButton}
            </MessageCardDisabledControlCursorWrapper>
          </Tooltip>
        )}
        {hasDownloadChoices ? (
          <PowerMenu
            id="attachment-preview-download-menu"
            anchorEl={downloadMenuAnchor}
            open={downloadMenuAnchor != null}
            onClose={() => setDownloadMenuAnchor(null)}
            anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
            transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            slotProps={{ root: { sx: { zIndex: 1501 } } }}
          >
            {choices.map((item) => {
              const itemDownload = item.download;
              const key = `${item.label}:${item.downloadKey ?? ''}`;
              const itemDownloading =
                item.downloadKey != null && isDownloadStarting?.(item.downloadKey) === true;
              return 'href' in itemDownload && typeof itemDownload.href === 'string' ? (
                <MenuItem
                  key={key}
                  component="a"
                  href={itemDownload.href}
                  download={itemDownload.fileName}
                  disabled={itemDownloading}
                  onClick={(event) => {
                    startDownload(event, item.downloadKey);
                    setDownloadMenuAnchor(null);
                  }}
                >
                  {itemDownloading ? 'Завантаження…' : item.label}
                </MenuItem>
              ) : (
                <MenuItem
                  key={key}
                  disabled={itemDownloading}
                  onClick={(event) => {
                    if (startDownload(event, item.downloadKey)) itemDownload.onDownload();
                    setDownloadMenuAnchor(null);
                  }}
                >
                  {itemDownloading ? 'Завантаження…' : item.label}
                </MenuItem>
              );
            })}
          </PowerMenu>
        ) : null}
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
        {onClose ? (
          <Tooltip title={closeLabel} enterDelay={300}>
            <IconButton aria-label={closeLabel} size="small" onClick={onClose} sx={iconButtonSx}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Stack>
    </Box>
  );
}
