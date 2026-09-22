import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import { Box, Button, CircularProgress, Stack, Tooltip, Typography } from '@mui/material';
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';

import type {
  SignalMediaKmzConversionStatusRsp,
  SignalMediaKmzPreviewRsp,
} from '../../../../../../Bindings';
import { PowerAlert } from '../../../../components/PowerAlert';
import { useOptionalPowerSnackbar } from '../../../../components/PowerSnackbar';
import {
  getKmzAttachmentConversionStatus,
  getKmzAttachmentPreview,
  kmzAttachmentConversionDownloadUrl,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasPreviewGeometry(preview: SignalMediaKmzPreviewRsp): boolean {
  return preview.points.length > 0 || preview.lineStrings.some((line) => line.coords.length >= 2);
}

function DownloadAction({
  href,
  fileName,
  fallbackFileName,
  label,
  variant,
  downloadKey,
  disabled,
  isDownloadStarting,
  onDownloadStart,
}: {
  href?: string;
  fileName: string;
  fallbackFileName: string;
  label: string;
  variant: 'outlined' | 'contained';
  downloadKey: string;
  disabled: boolean;
} & Partial<MessageCardDownloadGuardProps>) {
  const downloading = isDownloadStarting?.(downloadKey) ?? false;
  const unavailable = disabled || downloading || href == null || href === '';
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
    <Tooltip title={downloading ? 'Завантаження…' : label} enterDelay={300}>
      <span>
        <Button
          component="a"
          href={unavailable ? undefined : href}
          download={mediaDownloadAttr(fileName, fallbackFileName)}
          target="_blank"
          rel="noopener noreferrer"
          disabled={unavailable}
          aria-label={downloading ? 'Завантаження…' : label}
          aria-busy={downloading}
          onClick={startDownload}
          size="small"
          variant={variant}
          startIcon={
            downloading ? <CircularProgress size={16} color="inherit" /> : <DownloadOutlinedIcon />
          }
          sx={{ textTransform: 'none', whiteSpace: 'nowrap' }}
        >
          {label}
        </Button>
      </span>
    </Tooltip>
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
  const [baseLayerId, setBaseLayerId] = useState<BaseLayerId>(DEFAULT_BASE_LAYER_ID);

  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  const reportError = useCallback((message: string) => {
    setLoadError(message);
    notifyRef.current({ severity: 'error', message: `Не вдалося відкрити KMZ: ${message}` });
  }, []);

  useEffect(() => {
    setStatus(source.initialStatus);
    setConvertedFileName(null);
    setPreview(null);
    setLoadError(null);
    setReloadKey(0);
  }, [source.initialStatus, source.mediaId]);

  useEffect(() => {
    const controller = new AbortController();
    let pollTimer: number | null = null;

    const load = async () => {
      try {
        setLoadError(null);
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
  }, [reloadKey, reportError, source.mediaId]);

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
            action={<Button onClick={() => setReloadKey((value) => value + 1)}>Повторити</Button>}
          >
            {loadError}
          </PowerAlert>
        ) : preview ? (
          <PowerAlert severity="info" autoHideDuration={null}>
            У конвертованому KMZ немає геометрій для попереднього перегляду.
          </PowerAlert>
        ) : (
          <Stack direction="row" spacing={1.5} alignItems="center">
            <CircularProgress size={22} />
            <Typography color="text.secondary">
              {convertedReady ? 'Завантаження попереднього перегляду…' : 'Конвертація файлу в KMZ…'}
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
          navigation={navigation}
          onClose={onClose}
          additionalActions={
            <>
              <DownloadAction
                href={source.originalHref}
                fileName={source.fileName}
                fallbackFileName="attachment"
                label="Завантажити оригінал"
                variant="outlined"
                downloadKey={`media:${source.mediaId}`}
                disabled={source.originalHref === ''}
                isDownloadStarting={isDownloadStarting}
                onDownloadStart={onDownloadStart}
              />
              <DownloadAction
                href={
                  convertedReady ? kmzAttachmentConversionDownloadUrl(source.mediaId) : undefined
                }
                fileName={convertedFileName ?? 'converted.kmz'}
                fallbackFileName="converted.kmz"
                label="Завантажити конвертований KMZ"
                variant="contained"
                downloadKey={`media-converted:${source.mediaId}`}
                disabled={!convertedReady}
                isDownloadStarting={isDownloadStarting}
                onDownloadStart={onDownloadStart}
              />
            </>
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
