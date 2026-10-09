import { useCallback, useEffect } from 'react';
import { CircularProgress } from '@mui/material';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { HttpRequestError } from '../../../services/api/client';
import type { FilePreviewLifecycleProps } from '../../shared/message-card/attachment-preview/file-preview-source';
import { MapFilePreview } from '../../shared/message-card/renderers/MapFilePreview';
import { useDeviceFileGeodataPreview } from '../use-device-file-geodata-preview';
import type { DeviceFilePreviewSource } from '../use-device-file-preview';

export function DeviceFileGeodataPreview({
  source,
  lifecycle,
}: {
  source: DeviceFilePreviewSource;
  lifecycle: FilePreviewLifecycleProps;
}) {
  const geodata = useDeviceFileGeodataPreview(source, lifecycle);
  const { notify } = useOptionalPowerSnackbar();
  const generation = geodata.status?.generation;
  const message = geodata.status?.errorMessage;
  useEffect(() => {
    if (geodata.state === 'failed' && message) notify({ severity: 'error', message });
  }, [geodata.state, generation, message, notify]);
  const onError = useCallback(
    (error: unknown) => {
      if (!lifecycle.isCurrent()) return;
      if (error instanceof HttpRequestError && error.status === 409) geodata.refresh();
      else lifecycle.onError(error);
    },
    [lifecycle.isCurrent, lifecycle.onError, geodata.refresh],
  );
  if (geodata.state === 'ready' && geodata.status?.resultUrl && generation) {
    return (
      <MapFilePreview
        key={generation}
        source={{
          ...source,
          key: `${source.key}/${generation}`,
          originalHref: geodata.status.resultUrl,
          extension: 'kmz',
          contentType: 'application/vnd.google-earth.kmz',
          sizeBytes: geodata.status.resultSizeBytes,
        }}
        format="kmz"
        lifecycle={{ ...lifecycle, onError }}
      />
    );
  }
  if (geodata.state === 'failed')
    return (
      <div className="p-echo-lg">
        <PowerAlert severity="error" autoHideDuration={null}>
          {message ?? 'Не вдалося підготувати перегляд мапи.'}
        </PowerAlert>
        {geodata.status?.retryable && (
          <PowerButton
            disabled={!geodata.canRetry || geodata.retrying}
            onClick={() => void geodata.retry()}
          >
            {geodata.retrying ? 'Підготовка…' : 'Повторити підготовку'}
          </PowerButton>
        )}
      </div>
    );
  if (geodata.state === 'waiting')
    return (
      <div className="p-echo-lg">
        <p>Підготовка триває.</p>
        <PowerButton onClick={geodata.refresh}>Перевірити стан</PowerButton>
      </div>
    );
  return (
    <div className="flex items-center gap-echo-md p-echo-lg">
      <CircularProgress aria-label="Підготовка мапи" />
      <p>
        {geodata.status?.status === 'queued' ? 'Очікування підготовки мапи…' : 'Підготовка мапи…'}
      </p>
    </div>
  );
}
