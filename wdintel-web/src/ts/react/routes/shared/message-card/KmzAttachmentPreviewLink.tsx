import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  SignalMediaKmzConversionStatusRsp,
  SignalMediaKmzPreviewRsp,
} from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import {
  getKmzAttachmentConversionStatus,
  getKmzAttachmentPreview,
  kmzAttachmentConversionDownloadUrl,
} from '../../../services/api/kmz-attachment-conversion';
import { isAbortError } from '../../../services/api/client';
import { KmzAttachmentPreviewMap } from './KmzAttachmentPreviewMap';
import {
  guardMessageCardDownloadClick,
  mediaDownloadAttr,
  type MessageCardDownloadGuardProps,
} from './MessageCardMedia';

const CONVERSION_STATUS_POLL_MS = 2_000;

type Props = {
  mediaId: string;
  originalHref: string;
  fileName: string;
  initialStatus: string;
  selected?: boolean;
} & Partial<MessageCardDownloadGuardProps>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasPreviewGeometry(preview: SignalMediaKmzPreviewRsp): boolean {
  return preview.points.length > 0 || preview.lineStrings.some((line) => line.coords.length >= 2);
}

export function KmzAttachmentPreviewLink({
  mediaId,
  originalHref,
  fileName,
  initialStatus,
  selected = false,
  isDownloadStarting,
  onDownloadStart,
}: Props) {
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  const [open, setOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState(initialStatus);
  const [convertedFileName, setConvertedFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<SignalMediaKmzPreviewRsp | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  const reportError = useCallback((message: string) => {
    setLoadError(message);
    notifyRef.current({ severity: 'error', message: `Не вдалося відкрити KMZ: ${message}` });
  }, []);

  useEffect(() => {
    setStatus(initialStatus);
    setConvertedFileName(null);
    setPreview(null);
    setLoadError(null);
  }, [initialStatus, mediaId]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let pollTimer: number | null = null;

    const load = async () => {
      try {
        setLoadError(null);
        const result: SignalMediaKmzConversionStatusRsp = await getKmzAttachmentConversionStatus(
          mediaId,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setStatus(result.status);
        setConvertedFileName(result.convertedFileName);
        if (result.status === 'done') {
          const convertedPreview = await getKmzAttachmentPreview(mediaId, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setPreview(convertedPreview);
          return;
        }
        setPreview(null);
        if (result.status === 'error') {
          reportError(result.error ?? 'Конвертація завершилася з помилкою.');
          return;
        }
        pollTimer = window.setTimeout(load, CONVERSION_STATUS_POLL_MS);
      } catch (error) {
        if (!isAbortError(error)) reportError(errorMessage(error));
      }
    };

    void load();
    return () => {
      controller.abort();
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [initialStatus, mediaId, open, reloadKey, reportError]);

  const guardDownload = useCallback(
    (event: React.MouseEvent<HTMLElement>, key: string) => {
      if (!isDownloadStarting || !onDownloadStart) return;
      guardMessageCardDownloadClick(event, key, { isDownloadStarting, onDownloadStart });
    },
    [isDownloadStarting, onDownloadStart],
  );
  const originalDownloadKey = `media:${mediaId}`;
  const convertedDownloadKey = `media-converted:${mediaId}`;
  const originalDownloading = isDownloadStarting?.(originalDownloadKey) ?? false;
  const convertedDownloading = isDownloadStarting?.(convertedDownloadKey) ?? false;
  const convertedReady = status === 'done';

  return (
    <>
      <Tooltip title={fileName} enterDelay={400}>
        <Button
          size="small"
          variant="outlined"
          onClick={() => setOpen(true)}
          aria-current={selected ? 'true' : undefined}
          data-summary-selected={selected ? 'true' : undefined}
          sx={{
            mb: 0.5,
            width: 'fit-content',
            minWidth: 0,
            maxWidth: '100%',
            minHeight: 26,
            py: 0.25,
            px: 0.75,
            fontSize: 11,
            lineHeight: 1.25,
            textTransform: 'none',
            fontWeight: 500,
            color: 'text.primary',
            borderColor: selected ? 'primary.main' : 'divider',
            boxShadow: selected ? 1 : undefined,
            backgroundColor: selected ? 'action.selected' : undefined,
            overflow: 'hidden',
            justifyContent: 'flex-start',
            '& .MuiButton-startIcon': { mr: 0.35, ml: -0.25, '& svg': { fontSize: 14 } },
          }}
          startIcon={<MapOutlinedIcon aria-hidden />}
        >
          <Box
            component="span"
            sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {fileName}
          </Box>
        </Button>
      </Tooltip>
      {open ? (
        <Dialog open onClose={() => setOpen(false)} fullWidth maxWidth="lg" disableRestoreFocus>
          <DialogTitle>Попередній перегляд KMZ: {fileName}</DialogTitle>
          <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
              <Button
                component="a"
                variant="outlined"
                href={originalHref}
                download={mediaDownloadAttr(fileName, 'attachment')}
                target="_blank"
                rel="noopener noreferrer"
                disabled={originalDownloading || originalHref === ''}
                onClick={(event) => guardDownload(event, originalDownloadKey)}
                startIcon={
                  originalDownloading ? <CircularProgress size={16} /> : <DownloadOutlinedIcon />
                }
              >
                Завантажити оригінал
              </Button>
              <Button
                component="a"
                variant="contained"
                href={convertedReady ? kmzAttachmentConversionDownloadUrl(mediaId) : undefined}
                download={mediaDownloadAttr(convertedFileName ?? 'converted.kmz', 'converted.kmz')}
                target="_blank"
                rel="noopener noreferrer"
                disabled={!convertedReady || convertedDownloading}
                onClick={(event) => guardDownload(event, convertedDownloadKey)}
                startIcon={
                  convertedDownloading ? <CircularProgress size={16} /> : <DownloadOutlinedIcon />
                }
              >
                Завантажити конвертований KMZ
              </Button>
            </Stack>
            {loadError ? (
              <PowerAlert
                severity="error"
                autoHideDuration={null}
                action={
                  <Button onClick={() => setReloadKey((value) => value + 1)}>Повторити</Button>
                }
              >
                {loadError}
              </PowerAlert>
            ) : preview && hasPreviewGeometry(preview) ? (
              <KmzAttachmentPreviewMap preview={preview} />
            ) : preview ? (
              <PowerAlert severity="info" autoHideDuration={null}>
                У конвертованому KMZ немає геометрій для попереднього перегляду.
              </PowerAlert>
            ) : (
              <Stack direction="row" spacing={1.5} alignItems="center" sx={{ py: 4 }}>
                <CircularProgress size={22} />
                <Typography color="text.secondary">
                  {convertedReady
                    ? 'Завантаження попереднього перегляду…'
                    : 'Конвертація файлу в KMZ…'}
                </Typography>
              </Stack>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setOpen(false)}>Закрити</Button>
          </DialogActions>
        </Dialog>
      ) : null}
    </>
  );
}
