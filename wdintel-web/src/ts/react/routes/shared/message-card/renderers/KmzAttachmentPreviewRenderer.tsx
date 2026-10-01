import MoreVertIcon from '@mui/icons-material/MoreVert';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';

import type { SignalMediaKmzConversionStatusRsp } from '../../../../../../Bindings';
import { PowerAlert } from '../../../../components/PowerAlert';
import { PowerMenu } from '../../../../components/PowerMenu';
import { useOptionalPowerSnackbar } from '../../../../components/PowerSnackbar';
import {
  getKmzAttachmentConversionStatus,
  kmzAttachmentConversionDownloadUrl,
  retryKmzAttachmentConversion,
} from '../../../../services/api/kmz-attachment-conversion';
import { isAbortError } from '../../../../services/api/client';
import { BaseLayerId, DEFAULT_BASE_LAYER_ID } from '../../../../../maps/base-layers';
import { CoordinateMapPreviewControls } from '../CoordinateMapPreviewControls';
import { KmzAttachmentPreviewMap } from '../KmzAttachmentPreviewMap';
import { fetchCachedDocumentResponse } from '../document-preview-utils';
import {
  MAX_KMZ_PREVIEW_SOURCE_BYTES,
  isNativeKmlOrKmz,
  isTerminalKmzPreviewError,
  kmzPreviewErrorCopy,
} from '../kmz/kmz-preview-utils';
import type { KmzPreview } from '../kmz/kmz-preview-types';
import { runWorkerTask } from '../workers/worker-client';
import { mediaDownloadAttr, type MessageCardDownloadGuardProps } from '../MessageCardMedia';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import type {
  KmzAttachmentPreviewSource,
  MessageCardPreviewNavigation,
} from '../attachment-preview/message-card-preview.types';

const POLL_MS = 2_000;
const MAX_POLLS = 60;
const REQUEST_DEADLINE_MS = 20_000;
const WORKER_PARSE_DEADLINE_MS = 20_000;
const errorDetails = (error: unknown) => (error instanceof Error ? error.message : String(error));
const hasGeometry = (preview: KmzPreview) =>
  preview.points.length > 0 ||
  preview.lineStrings.some((line) => line.coords.length >= 2) ||
  preview.polygons.some((polygon) => polygon.rings.some((ring) => ring.length >= 3));

function withRequestDeadline<T>(
  parentSignal: AbortSignal,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal.addEventListener('abort', abort, { once: true });
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('KMZ_REQUEST_TIMEOUT'));
      controller.abort();
    }, REQUEST_DEADLINE_MS);
    void request(controller.signal)
      .then(resolve, reject)
      .finally(() => {
        window.clearTimeout(timer);
        parentSignal.removeEventListener('abort', abort);
      });
  });
}

function ConvertedDownload({
  href,
  fileName,
  downloadKey,
  isDownloadStarting,
  onDownloadStart,
}: {
  href: string;
  fileName: string;
  downloadKey: string;
} & Partial<MessageCardDownloadGuardProps>) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const downloading = isDownloadStarting?.(downloadKey) ?? false;
  return (
    <>
      <Tooltip title="Додаткові завантаження">
        <IconButton
          aria-label="Додаткові завантаження"
          onClick={(event) => setAnchor(event.currentTarget)}
          size="small"
        >
          <MoreVertIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <PowerMenu
        id="converted-kmz-download-menu"
        anchorEl={anchor}
        open={anchor != null}
        onClose={() => setAnchor(null)}
      >
        <MenuItem
          component="a"
          href={downloading ? undefined : href}
          download={mediaDownloadAttr(fileName, 'converted.kmz')}
          disabled={downloading}
          onClick={(event) => {
            event.preventDefault();
            if (
              isDownloadStarting != null &&
              onDownloadStart != null &&
              (isDownloadStarting(downloadKey) || !onDownloadStart(downloadKey))
            )
              return;
            window.setTimeout(() => {
              const link = document.createElement('a');
              link.href = href;
              link.download = mediaDownloadAttr(fileName, 'converted.kmz');
              document.body.append(link);
              link.click();
              link.remove();
              setAnchor(null);
            });
          }}
        >
          {downloading ? 'Завантаження…' : `Завантажити ${fileName}`}
        </MenuItem>
      </PowerMenu>
    </>
  );
}

export function KmzAttachmentPreviewRenderer({
  source,
  navigation,
  onClose,
  isDownloadStarting,
  onDownloadStart,
}: {
  source: KmzAttachmentPreviewSource;
  navigation: MessageCardPreviewNavigation;
  onClose: () => void;
} & Partial<MessageCardDownloadGuardProps>) {
  const { notify } = useOptionalPowerSnackbar();
  const notifyRef = useRef(notify);
  const [reloadKey, setReloadKey] = useState(0);
  const [status, setStatus] = useState(source.initialStatus);
  const [convertedFileName, setConvertedFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<KmzPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseLayerId, setBaseLayerId] = useState<BaseLayerId>(DEFAULT_BASE_LAYER_ID);
  const nativeFormat = source.nativeFormat ?? isNativeKmlOrKmz(source.fileName, source.contentType);
  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);
  const reportError = useCallback((value: unknown) => {
    const details = errorDetails(value);
    setError(details);
    notifyRef.current({ severity: 'error', message: kmzPreviewErrorCopy(details) });
  }, []);

  useEffect(() => {
    setStatus(source.initialStatus);
    setConvertedFileName(null);
    setPreview(null);
    setError(null);
    if (
      source.sizeBytes != null &&
      source.sizeBytes > MAX_KMZ_PREVIEW_SOURCE_BYTES &&
      nativeFormat != null
    ) {
      reportError(new Error('KMZ_SOURCE_TOO_LARGE'));
      return;
    }
    const controller = new AbortController();
    let timer: number | null = null;
    let polls = 0;
    const parse = async (href: string, format: 'kml' | 'kmz') => {
      const { buffer } = await withRequestDeadline(controller.signal, (signal) =>
        fetchCachedDocumentResponse(
          href,
          MAX_KMZ_PREVIEW_SOURCE_BYTES,
          'KMZ_SOURCE_TOO_LARGE',
          signal,
        ),
      );
      return runWorkerTask<{ buffer: ArrayBuffer; format: 'kml' | 'kmz' }, KmzPreview>(
        () =>
          new Worker(new URL('../kmz/kmz-preview.worker.ts', import.meta.url), { type: 'module' }),
        { buffer, format },
        controller.signal,
        [buffer],
        WORKER_PARSE_DEADLINE_MS,
      );
    };
    const load = async () => {
      try {
        if (nativeFormat != null) {
          const value = await parse(source.originalHref, nativeFormat);
          if (!controller.signal.aborted) setPreview(value);
          return;
        }
        const result: SignalMediaKmzConversionStatusRsp = await withRequestDeadline(
          controller.signal,
          (signal) => getKmzAttachmentConversionStatus(source.mediaId, { signal }),
        );
        if (controller.signal.aborted) return;
        setStatus(result.status);
        setConvertedFileName(result.convertedFileName);
        if (result.status === 'done') {
          const value = await parse(kmzAttachmentConversionDownloadUrl(source.mediaId), 'kmz');
          if (!controller.signal.aborted) setPreview(value);
          return;
        }
        if (result.status === 'error') {
          reportError(new Error(result.error ?? 'Конвертація завершилася з помилкою.'));
          return;
        }
        if (++polls >= MAX_POLLS) {
          reportError(new Error('Перевищено час очікування завершення конвертації.'));
          return;
        }
        timer = window.setTimeout(load, POLL_MS);
      } catch (loadError) {
        if (!controller.signal.aborted && !isAbortError(loadError)) reportError(loadError);
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [nativeFormat, reloadKey, reportError, source]);

  const convertedReady = status === 'done';
  const stage =
    preview && hasGeometry(preview) ? (
      <KmzAttachmentPreviewMap preview={preview} baseLayerId={baseLayerId} />
    ) : (
      <Box
        sx={{
          flex: '1 1 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 0,
          p: 3,
        }}
      >
        {error ? (
          <PowerAlert
            severity="error"
            autoHideDuration={null}
            action={
              isTerminalKmzPreviewError(error) ? undefined : (
                <Button
                  onClick={() => {
                    if (status === 'error' && nativeFormat == null)
                      void retryKmzAttachmentConversion(source.mediaId)
                        .then(() => setReloadKey((value) => value + 1))
                        .catch(reportError);
                    else setReloadKey((value) => value + 1);
                  }}
                >
                  Повторити
                </Button>
              )
            }
          >
            <Stack spacing={0.5}>
              <span>{kmzPreviewErrorCopy(error)}</span>
              <Box component="details">
                <Box component="summary" sx={{ cursor: 'pointer' }}>
                  Технічні деталі
                </Box>
                <Typography component="pre" variant="caption" sx={{ m: 0, whiteSpace: 'pre-wrap' }}>
                  {error}
                </Typography>
              </Box>
            </Stack>
          </PowerAlert>
        ) : preview ? (
          <PowerAlert severity="info" autoHideDuration={null}>
            У файлі немає геометрій для попереднього перегляду.
          </PowerAlert>
        ) : (
          <Stack direction="row" spacing={1.5} alignItems="center">
            <CircularProgress size={22} />
            <Typography color="text.secondary">
              {nativeFormat != null || convertedReady
                ? 'Завантаження файлу…'
                : status === 'pending'
                  ? 'Очікування початку конвертації…'
                  : 'Конвертація вихідного файлу…'}
            </Typography>
          </Stack>
        )}
      </Box>
    );
  return (
    <MessageCardAttachmentPreviewLayout
      navigation={navigation}
      swipeEnabled={false}
      header={
        <MessageCardAttachmentPreviewHeader
          fileName={source.fileName}
          download={{
            href: source.originalHref,
            fileName: mediaDownloadAttr(source.fileName, 'attachment'),
          }}
          downloadKey={`media:${source.mediaId}`}
          isDownloadStarting={isDownloadStarting}
          onDownloadStart={onDownloadStart}
          navigation={navigation}
          onClose={onClose}
          overflowAction={
            nativeFormat == null && convertedReady && convertedFileName ? (
              <ConvertedDownload
                href={kmzAttachmentConversionDownloadUrl(source.mediaId)}
                fileName={convertedFileName}
                downloadKey={`media-converted:${source.mediaId}`}
                isDownloadStarting={isDownloadStarting}
                onDownloadStart={onDownloadStart}
              />
            ) : null
          }
        />
      }
      stage={stage}
      controls={
        preview && hasGeometry(preview) ? (
          <CoordinateMapPreviewControls
            baseLayerId={baseLayerId}
            onBaseLayerChange={setBaseLayerId}
          />
        ) : undefined
      }
    />
  );
}
