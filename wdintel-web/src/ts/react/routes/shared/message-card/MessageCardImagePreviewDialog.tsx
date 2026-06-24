import type { KeyboardEvent } from 'react';
import { useState } from 'react';
import ChevronLeftOutlinedIcon from '@mui/icons-material/ChevronLeftOutlined';
import ChevronRightOutlinedIcon from '@mui/icons-material/ChevronRightOutlined';
import CloseOutlinedIcon from '@mui/icons-material/CloseOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import { Box, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack, Tooltip, Typography } from '@mui/material';

function sanitizeDownloadFileName(fileName: string): string {
  return fileName.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').trim();
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function deriveImageDownloadName(href: string, index: number): string {
  const fallbackName = `image-${index + 1}`;
  if (href.trim() === '') return fallbackName;

  try {
    const url = new URL(href, window.location.href);
    const pathName = url.pathname.split('/').filter(Boolean).pop() ?? '';
    const decodedPathName = pathName === '' ? null : safeDecodeURIComponent(pathName);
    const basename = decodedPathName ?? pathName;
    const sanitized = sanitizeDownloadFileName(basename);
    return sanitized === '' ? fallbackName : sanitized;
  } catch {
    const rawPathName = href.split('/').filter(Boolean).pop() ?? '';
    const pathName = rawPathName.split('?')[0].split('#')[0];
    const decodedPathName = pathName === '' ? null : safeDecodeURIComponent(pathName);
    const basename = decodedPathName ?? pathName;
    const sanitized = sanitizeDownloadFileName(basename);
    return sanitized === '' ? fallbackName : sanitized;
  }
}

function normalizePreviewIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

export function MessageImagePreviewDialog({
  imageHrefs,
  initialIndex = 0,
  currentIndex,
  open,
  onClose,
  onIndexChange,
}: {
  imageHrefs: string[];
  initialIndex?: number;
  currentIndex?: number;
  open: boolean;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  const [failedHref, setFailedHref] = useState<string | null>(null);
  const resolvedIndex = normalizePreviewIndex(currentIndex ?? initialIndex, imageHrefs.length);
  const currentHref = imageHrefs[resolvedIndex] ?? '';
  const imageCount = imageHrefs.length;
  const hasCarousel = imageCount > 1;
  const imageName = deriveImageDownloadName(currentHref, resolvedIndex);
  const title = imageCount > 0 ? `${resolvedIndex + 1} / ${imageCount}` : '0 / 0';

  if (!open || imageCount === 0) return null;

  const goToIndex = (nextIndex: number) => onIndexChange(normalizePreviewIndex(nextIndex, imageCount));
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      goToIndex(resolvedIndex - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      goToIndex(resolvedIndex + 1);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="lg"
      aria-labelledby="message-image-preview-title"
      PaperProps={{
        onKeyDown: handleKeyDown,
        sx: {
          backgroundColor: '#0b0f14',
          backgroundImage: 'none',
          color: '#f4f7fb',
        },
      }}
      BackdropProps={{
        sx: {
          backgroundColor: 'rgba(0, 0, 0, 0.82)',
        },
      }}
    >
      <DialogTitle id="message-image-preview-title" sx={{ pr: 1, py: 1.25 }}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Typography component="span" variant="subtitle2" sx={{ fontWeight: 700 }}>
            Зображення
          </Typography>
          <Typography component="span" variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }} data-image-preview-counter>
            {title}
          </Typography>
        </Stack>
      </DialogTitle>
      <DialogContent
        sx={{
          px: 2,
          pb: 1.5,
          display: 'flex',
          flexDirection: 'column',
          gap: 1.5,
          alignItems: 'stretch',
          minHeight: '40vh',
        }}
      >
        <Box
          sx={{
            flex: '1 1 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 0,
            overflow: 'hidden',
            borderRadius: 1.5,
            backgroundColor: '#111821',
            px: 1,
            py: 1,
          }}
        >
          <Box
            component="img"
            src={currentHref}
            alt={`Зображення ${resolvedIndex + 1}`}
            data-image-preview-image
            onLoad={() => setFailedHref(null)}
            onError={() => setFailedHref(currentHref)}
            sx={{
              display: failedHref === currentHref ? 'none' : 'block',
              maxWidth: '100%',
              maxHeight: 'calc(100vh - 220px)',
              objectFit: 'contain',
            }}
          />
          {failedHref === currentHref ? (
            <Typography variant="body2" sx={{ color: 'rgba(244, 247, 251, 0.8)', textAlign: 'center' }}>
              Зображення недоступне
            </Typography>
          ) : null}
        </Box>
        <Stack direction="row" spacing={1} justifyContent="space-between" alignItems="center" sx={{ minWidth: 0 }}>
          {hasCarousel ? (
            <Stack direction="row" spacing={0.5}>
              <Tooltip title="Попереднє" enterDelay={300}>
                <IconButton
                  onClick={() => goToIndex(resolvedIndex - 1)}
                  aria-label="Попереднє"
                  size="small"
                  sx={{ color: 'inherit' }}
                >
                  <ChevronLeftOutlinedIcon />
                </IconButton>
              </Tooltip>
              <Tooltip title="Наступне" enterDelay={300}>
                <IconButton
                  onClick={() => goToIndex(resolvedIndex + 1)}
                  aria-label="Наступне"
                  size="small"
                  sx={{ color: 'inherit' }}
                >
                  <ChevronRightOutlinedIcon />
                </IconButton>
              </Tooltip>
            </Stack>
          ) : (
            <Box sx={{ minWidth: 0 }} />
          )}
          <Stack direction="row" spacing={0.5}>
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
                <OpenInNewOutlinedIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Завантажити" enterDelay={300}>
              <IconButton
                component="a"
                href={currentHref}
                download={imageName}
                aria-label="Завантажити"
                size="small"
                sx={{ color: 'inherit' }}
              >
                <DownloadOutlinedIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Закрити" enterDelay={300}>
              <IconButton onClick={onClose} aria-label="Закрити" size="small" sx={{ color: 'inherit' }}>
                <CloseOutlinedIcon />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 2, pb: 2, pt: 0, justifyContent: 'flex-start' }}>
        <Typography variant="caption" sx={{ color: 'rgba(244, 247, 251, 0.72)' }}>
          {currentHref}
        </Typography>
      </DialogActions>
    </Dialog>
  );
}
