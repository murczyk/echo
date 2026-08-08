import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DownloadIcon from '@mui/icons-material/Download';
import InfoIcon from '@mui/icons-material/Info';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import {
  Button,
  CircularProgress,
  DialogActions,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { MouseEvent, ReactNode } from 'react';

import { getAttachmentPreviewActionBarSx } from './message-card-attachment-preview';
import type { MessageCardPreviewNavigation } from './message-card-preview.types';
import { MessageCardDisabledControlCursorWrapper } from '../MessageCardDisabledControlCursorWrapper';

export type AttachmentPreviewDownload =
  | { href: string; fileName: string; onDownload?: never }
  | { href?: never; fileName?: never; onDownload: () => void };

export function MessageCardAttachmentPreviewActions({
  openHref,
  download,
  downloadKey,
  navigation,
  additionalActions,
  status,
  onInfoClick,
  onClose,
  isDownloadStarting,
  onDownloadStart,
}: {
  openHref?: string | null;
  download?: AttachmentPreviewDownload;
  downloadKey?: string;
  navigation: MessageCardPreviewNavigation;
  additionalActions?: ReactNode;
  status?: ReactNode;
  onInfoClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  onClose: () => void;
  isDownloadStarting?: (downloadKey: string) => boolean;
  onDownloadStart?: (downloadKey: string) => boolean;
}) {
  const theme = useTheme();
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

  const downloadButton =
    download == null ? null : 'href' in download && typeof download.href === 'string' ? (
      <IconButton
        component="a"
        href={download.href}
        download={download.fileName}
        aria-label={downloading ? 'Завантаження…' : 'Завантажити'}
        aria-busy={downloading}
        disabled={downloading}
        onClick={startDownload}
        size="small"
        sx={{ color: 'text.secondary' }}
      >
        {downloading ? <CircularProgress size={14} aria-label="Завантаження…" /> : <DownloadIcon />}
      </IconButton>
    ) : (
      <IconButton
        aria-label={downloading ? 'Завантаження…' : 'Завантажити'}
        aria-busy={downloading}
        disabled={downloading}
        onClick={(event) => {
          if (startDownload(event)) download.onDownload();
        }}
        size="small"
        sx={{ color: 'text.secondary' }}
      >
        {downloading ? <CircularProgress size={14} aria-label="Завантаження…" /> : <DownloadIcon />}
      </IconButton>
    );

  return (
    <DialogActions sx={getAttachmentPreviewActionBarSx(theme)}>
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{ justifySelf: 'start', minWidth: 0, flexWrap: 'wrap' }}
      >
        {onInfoClick != null ? (
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
        ) : null}
        {additionalActions}
        {typeof openHref === 'string' && openHref.trim() !== '' ? (
          <Tooltip title="Відкрити в новій вкладці" enterDelay={300}>
            <IconButton
              component="a"
              href={openHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Відкрити в новій вкладці"
              size="small"
              sx={{ color: 'text.secondary' }}
            >
              <OpenInNewIcon />
            </IconButton>
          </Tooltip>
        ) : null}
        {downloadButton == null ? null : (
          <Tooltip title={downloading ? 'Завантаження…' : 'Завантажити'} enterDelay={300}>
            <MessageCardDisabledControlCursorWrapper disabled={downloading}>
              {downloadButton}
            </MessageCardDisabledControlCursorWrapper>
          </Tooltip>
        )}
        {status}
      </Stack>

      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        justifyContent="center"
        sx={{ justifySelf: 'center', minWidth: 0 }}
      >
        {hasCarousel ? (
          <Tooltip title="Попереднє" enterDelay={300}>
            <IconButton
              aria-label="Попереднє"
              size="small"
              onClick={navigation.onPrevious}
              sx={{ color: 'text.secondary' }}
              data-attachment-preview-nav="prev"
            >
              <ChevronLeftIcon />
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
              sx={{ color: 'text.secondary' }}
              data-attachment-preview-nav="next"
            >
              <ChevronRightIcon />
            </IconButton>
          </Tooltip>
        ) : null}
      </Stack>

      <Stack direction="row" justifyContent="flex-end" sx={{ justifySelf: 'end' }}>
        <Button aria-label="Закрити" onClick={onClose}>
          Закрити
        </Button>
      </Stack>
    </DialogActions>
  );
}
