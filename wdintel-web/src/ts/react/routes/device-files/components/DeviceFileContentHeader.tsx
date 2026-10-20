import FullscreenIcon from '@mui/icons-material/Fullscreen';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { IconButton } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { Typography } from '@mui/material';
import { useEffect, useRef } from 'react';
import type { DeviceFileSelection } from '../device-file-archive';
import { PowerButton } from '../../../components/PowerButton';
import type { useDeviceFilePreview } from '../use-device-file-preview';

export function DeviceFileContentHeader({
  file,
  preview,
  sessionScoped = false,
  revisionPinned = false,
  mobile = false,
  zoom,
  onZoomChange,
  onFullscreen,
}: {
  file: DeviceFileSelection;
  preview: ReturnType<typeof useDeviceFilePreview>;
  sessionScoped?: boolean;
  revisionPinned?: boolean;
  mobile?: boolean;
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  onFullscreen?: () => void;
}) {
  const path = file.absolutePath ?? (file.pathComponents.join(' / ') || file.name);
  return (
    <header
      className={
        mobile
          ? 'flex shrink-0 flex-col items-start gap-echo-sm border-b border-echo-divider-subtle p-echo-md'
          : 'flex min-h-echo-control-lg shrink-0 flex-wrap items-center gap-echo-md border-b border-echo-divider-subtle px-echo-lg py-echo-sm echo-sm:flex-nowrap'
      }
    >
      {mobile ? (
        <p className="m-0 text-[18px] font-semibold [overflow-wrap:anywhere]">{file.name}</p>
      ) : null}
      <Typography
        component="h2"
        variant="body2"
        id="device-file-content-title"
        title={path}
        tabIndex={0}
        className={
          mobile
            ? 'm-0 max-w-full font-normal! text-echo-text [overflow-wrap:anywhere]'
            : 'm-0 min-w-0 flex-1 basis-full overflow-x-auto whitespace-nowrap font-normal! text-echo-text echo-sm:basis-auto'
        }
      >
        {path}
      </Typography>
      {file.revision != null ? (
        <span className="inline-flex shrink-0 items-center gap-echo-xs whitespace-nowrap rounded-echo-sm bg-echo-success/20 px-echo-sm py-echo-xs text-echo-xs text-[color:color-mix(in_srgb,var(--echo-color-success)_60%,var(--echo-color-text))]">
          <span aria-hidden="true" className="size-echo-xs rounded-full bg-current" />
          Ревізія {file.revision} ·{' '}
          {revisionPinned ? 'За посиланням' : sessionScoped ? 'Із вибраної сесії' : 'Поточна'}
        </span>
      ) : null}
      <DeviceFileContentActions
        preview={preview}
        mobile={mobile}
        zoom={zoom}
        onZoomChange={onZoomChange}
        onFullscreen={onFullscreen}
      />
    </header>
  );
}

export function DeviceFileContentActions({
  preview,
  mobile = false,
  zoom,
  onZoomChange,
  onFullscreen,
}: {
  preview: ReturnType<typeof useDeviceFilePreview>;
  mobile?: boolean;
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  onFullscreen?: () => void;
}) {
  const downloadFocus = useRef<{ button: HTMLButtonElement; epoch: number | null } | null>(null);
  useEffect(() => {
    if (preview.downloading) return;
    const target = downloadFocus.current;
    downloadFocus.current = null;
    if (
      target &&
      target.epoch === preview.epoch &&
      target.button.isConnected &&
      !target.button.disabled &&
      document.activeElement === document.body
    ) {
      target.button.focus();
    }
  }, [preview.downloading, preview.epoch]);
  return (
    <>
      {zoom != null && onZoomChange && (
        <div className="flex shrink-0 items-center">
          <IconButton
            aria-label="Зменшити масштаб"
            disabled={zoom <= 50}
            onClick={() => onZoomChange(zoom - 25)}
          >
            <ZoomOutIcon />
          </IconButton>
          <span aria-live="polite">{zoom}%</span>
          <IconButton
            aria-label="Збільшити масштаб"
            disabled={zoom >= 300}
            onClick={() => onZoomChange(zoom + 25)}
          >
            <ZoomInIcon />
          </IconButton>
        </div>
      )}
      {onFullscreen && (
        <IconButton
          aria-label="На весь екран"
          disabled={preview.state !== 'ready'}
          onClick={onFullscreen}
        >
          <FullscreenIcon />
        </IconButton>
      )}
      <PowerButton
        key={preview.epoch}
        size="small"
        variant="contained"
        disableElevation
        sx={{ textTransform: 'none' }}
        className={mobile ? '!min-h-echo-control-lg w-full shrink-0' : 'h-echo-control-sm shrink-0'}
        startIcon={<DownloadIcon fontSize="small" />}
        onClick={(event) => {
          downloadFocus.current = { button: event.currentTarget, epoch: preview.epoch };
          void preview.download();
        }}
        disabled={!preview.canDownload || preview.downloading}
        aria-busy={preview.downloading}
        aria-label="Скачати файл"
      >
        {preview.downloading ? 'Завантаження…' : 'Скачати файл'}
      </PowerButton>
    </>
  );
}
