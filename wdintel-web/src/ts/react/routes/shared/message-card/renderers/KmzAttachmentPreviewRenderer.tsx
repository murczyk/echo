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

import type {
  SignalMediaKmzConversionStatusRsp,
  SignalMediaKmzPreviewRsp,
} from '../../../../../../Bindings';
import { PowerAlert } from '../../../../components/PowerAlert';
import { PowerMenu } from '../../../../components/PowerMenu';
import { useOptionalPowerSnackbar } from '../../../../components/PowerSnackbar';
import {
  getKmzAttachmentConversionStatus,
  getKmzAttachmentPreview,
  getNativeKmlAttachmentPreview,
  kmzAttachmentConversionDownloadUrl,
  retryKmzAttachmentConversion,
} from '../../../../services/api/kmz-attachment-conversion';
import { isAbortError } from '../../../../services/api/client';
import { BaseLayerId, DEFAULT_BASE_LAYER_ID } from '../../../../../maps/base-layers';
import { CoordinateMapPreviewControls } from '../CoordinateMapPreviewControls';
import { KmzAttachmentPreviewMap } from '../KmzAttachmentPreviewMap';
import {
  guardMessageCardDownloadClick,
  mediaDownloadAttr,
  type MessageCardDownloadGuardProps,
} from '../MessageCardMedia';
import { MessageCardAttachmentPreviewHeader } from '../attachment-preview/MessageCardAttachmentPreviewHeader';
import { MessageCardAttachmentPreviewLayout } from '../attachment-preview/MessageCardAttachmentPreviewLayout';
import type {
  KmzAttachmentPreviewSource,
  MessageCardPreviewNavigation,
} from '../attachment-preview/message-card-preview.types';

const CONVERSION_STATUS_POLL_MS = 2_000;
const CONVERSION_STATUS_MAX_POLLS = 60;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminalPreviewError(details: string): boolean {
  return /preview limit exceeded|invalid kml|kmz archive|archive.*(?:entries|expanded|size)|unsupported preview format/i.test(
    details,
  );
}

function previewErrorCopy(details: string): string {
  if (/original file is larger than 25 mib/i.test(details)) {
    return 'Перевищено ліміт попереднього перегляду 25 МіБ.';
  }
  if (/more than 100,000 coordinates/i.test(details)) {
    return 'Перевищено ліміт у 100 000 координат для попереднього перегляду.';
  }
  if (/archive.*(?:entries|expanded|size limit)|archive expands/i.test(details)) {
    return 'Перевищено ліміт розпакування KMZ для попереднього перегляду.';
  }
  if (isTerminalPreviewError(details)) {
    return 'Файл не можна відобразити у попередньому перегляді.';
  }
  return 'Не вдалося відкрити попередній перегляд.';
}

function hasPreviewGeometry(preview: SignalMediaKmzPreviewRsp): boolean {
  return (
    preview.points.length > 0 ||
    preview.lineStrings.some((line) => line.coords.length >= 2) ||
    preview.polygons.some((polygon) => polygon.rings.some((ring) => ring.length >= 3))
  );
}

function ConvertedKmzDownloadMenu({
  href,
  fileName,
  fallbackFileName,
  downloadKey,
  isDownloadStarting,
  onDownloadStart,
}: {
  href: string;
  fileName: string;
  fallbackFileName: string;
  downloadKey: string;
} & Partial<MessageCardDownloadGuardProps>) {
  const [anchorElement, setAnchorElement] = useState<HTMLElement | null>(null);
  const downloading = isDownloadStarting?.(downloadKey) ?? false;
  const unavailable = downloading || href === '';
  const startDownload = (event: MouseEvent<HTMLElement>) => {
    if (unavailable) {
      event.preventDefault();
      return;
    }
    if (isDownloadStarting && onDownloadStart) {
      guardMessageCardDownloadClick(event, downloadKey, { isDownloadStarting, onDownloadStart });
    }
  };

  return (
    <>
      <Tooltip title="Додаткові завантаження" enterDelay={300}>
        <IconButton
          aria-label="Додаткові завантаження"
          aria-controls={anchorElement ? 'converted-kmz-download-menu' : undefined}
          aria-expanded={anchorElement ? 'true' : undefined}
          aria-haspopup="menu"
          onClick={(event) => setAnchorElement(event.currentTarget)}
          size="small"
        >
          <MoreVertIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <PowerMenu
        id="converted-kmz-download-menu"
        anchorEl={anchorElement}
        open={anchorElement != null}
        onClose={() => setAnchorElement(null)}
      >
        <MenuItem
          component="a"
          href={unavailable ? undefined : href}
          download={mediaDownloadAttr(fileName, fallbackFileName)}
          target="_blank"
          rel="noopener noreferrer"
          disabled={unavailable}
          onClick={(event) => {
            startDownload(event);
            setAnchorElement(null);
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
  const [preview, setPreview] = useState<SignalMediaKmzPreviewRsp | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(true);
  const [baseLayerId, setBaseLayerId] = useState<BaseLayerId>(DEFAULT_BASE_LAYER_ID);

  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  const reportError = useCallback(
    (details: string, message = 'Не вдалося відкрити попередній перегляд.', canRetry = true) => {
      setLoadError(message);
      setErrorDetails(details);
      setRetryable(canRetry);
      notifyRef.current({ severity: 'error', message });
    },
    [],
  );

  useEffect(() => {
    setStatus(source.initialStatus);
    setConvertedFileName(null);
    setPreview(null);
    setLoadError(null);
    setErrorDetails(null);
    setRetryable(true);
    setReloadKey(0);
  }, [source.initialStatus, source.mediaId]);

  useEffect(() => {
    if (source.previewStatus === 'limit_exceeded') {
      setLoadError('Перевищено ліміт попереднього перегляду 25 МіБ. Оригінал можна завантажити.');
      setErrorDetails(null);
      setRetryable(false);
      return;
    }
    const controller = new AbortController();
    let pollTimer: number | null = null;
    let pollCount = 0;

    const load = async () => {
      try {
        setLoadError(null);
        setErrorDetails(null);
        setRetryable(true);
        if (source.nativePreview) {
          const nativePreview = await getNativeKmlAttachmentPreview(source.mediaId, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setPreview(nativePreview);
          return;
        }
        const result: SignalMediaKmzConversionStatusRsp = await getKmzAttachmentConversionStatus(
          source.mediaId,
          {
            signal: controller.signal,
          },
        );
        if (controller.signal.aborted) return;
        setStatus(result.status);
        setConvertedFileName(result.convertedFileName);
        if (result.status === 'done') {
          const convertedPreview = await getKmzAttachmentPreview(source.mediaId, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setPreview(convertedPreview);
          return;
        }
        setPreview(null);
        if (result.status === 'error') {
          reportError(
            result.error ?? 'Конвертація завершилася з помилкою.',
            'Не вдалося підготувати попередній перегляд.',
          );
          return;
        }
        pollCount += 1;
        if (pollCount >= CONVERSION_STATUS_MAX_POLLS) {
          reportError(
            'Перевищено час очікування завершення конвертації.',
            'Конвертація триває надто довго. Спробуйте повторити пізніше.',
          );
          return;
        }
        pollTimer = window.setTimeout(load, CONVERSION_STATUS_POLL_MS);
      } catch (error) {
        if (!isAbortError(error)) {
          const details = errorMessage(error);
          reportError(details, previewErrorCopy(details), !isTerminalPreviewError(details));
        }
      }
    };

    void load();
    return () => {
      controller.abort();
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [reloadKey, reportError, source.mediaId, source.nativePreview, source.previewStatus]);

  const convertedReady = status === 'done';
  const stage =
    preview && hasPreviewGeometry(preview) ? (
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
        {loadError ? (
          <PowerAlert
            severity="error"
            autoHideDuration={null}
            action={
              source.previewStatus === 'limit_exceeded' || !retryable ? undefined : (
                <Button
                  onClick={() => {
                    if (status === 'error' && !source.nativePreview) {
                      void retryKmzAttachmentConversion(source.mediaId)
                        .then(() => setReloadKey((value) => value + 1))
                        .catch((error: unknown) => reportError(errorMessage(error)));
                    } else {
                      setReloadKey((value) => value + 1);
                    }
                  }}
                >
                  Повторити
                </Button>
              )
            }
          >
            <Stack spacing={0.5}>
              <span>{loadError}</span>
              {errorDetails ? (
                <Box component="details">
                  <Box component="summary" sx={{ cursor: 'pointer' }}>
                    Технічні деталі
                  </Box>
                  <Typography
                    component="pre"
                    variant="caption"
                    sx={{ m: 0, whiteSpace: 'pre-wrap' }}
                  >
                    {errorDetails}
                  </Typography>
                </Box>
              ) : null}
            </Stack>
          </PowerAlert>
        ) : preview ? (
          <PowerAlert severity="info" autoHideDuration={null}>
            У конвертованому KMZ немає геометрій для попереднього перегляду.
          </PowerAlert>
        ) : (
          <Stack direction="row" spacing={1.5} alignItems="center">
            <CircularProgress size={22} />
            <Typography color="text.secondary">
              {convertedReady || source.nativePreview
                ? `Завантаження попереднього перегляду ${source.nativeFormat?.toUpperCase() ?? 'KMZ'}…`
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
            !source.nativePreview && convertedReady && convertedFileName ? (
              <ConvertedKmzDownloadMenu
                href={kmzAttachmentConversionDownloadUrl(source.mediaId)}
                fileName={convertedFileName}
                fallbackFileName="converted.kmz"
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
        preview && hasPreviewGeometry(preview) ? (
          <CoordinateMapPreviewControls
            baseLayerId={baseLayerId}
            onBaseLayerChange={setBaseLayerId}
          />
        ) : undefined
      }
    />
  );
}
