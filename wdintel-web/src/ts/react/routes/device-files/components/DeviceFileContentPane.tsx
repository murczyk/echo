import type { AiAgentFileCitation } from '../../../../../Bindings';
import { DeviceDocumentDetails } from './DeviceDocumentPreview';
import FolderZipOutlinedIcon from '@mui/icons-material/FolderZipOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import PendingActionsOutlinedIcon from '@mui/icons-material/PendingActionsOutlined';
import { CircularProgress } from '@mui/material';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';

import type { DeviceFileSelection } from '../device-file-archive';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerSnackbarProvider } from '../../../components/PowerSnackbar';
import { useDeviceFilePreview } from '../use-device-file-preview';
import { DeviceFileContentActions, DeviceFileContentHeader } from './DeviceFileContentHeader';

import { getDocumentFileKind } from '../../shared/message-card/document-file-kind';
import { getDocumentPreviewCapabilities } from '../../shared/message-card/document-preview-capabilities';
import { getFilePreviewKind } from '../../shared/message-card/file-preview-kind';
import { FilePreviewDialog } from '../../shared/message-card/attachment-preview/FilePreviewDialog';

const DocumentFilePreview = lazy(() =>
  import('../../shared/message-card/renderers/DocumentFilePreview').then((module) => ({
    default: module.DocumentFilePreview,
  })),
);
const DeviceFileImagePreview = lazy(() =>
  import('./DeviceFileImagePreview').then((module) => ({ default: module.DeviceFileImagePreview })),
);

const ZipFilePreview = lazy(() =>
  import('../../shared/message-card/renderers/ZipDocumentPreview').then((module) => ({
    default: module.ZipFilePreview,
  })),
);
const MapFilePreview = lazy(() =>
  import('../../shared/message-card/renderers/MapFilePreview').then((module) => ({
    default: module.MapFilePreview,
  })),
);

const DeviceFileGeodataPreview = lazy(() =>
  import('./DeviceFileGeodataPreview').then((module) => ({
    default: module.DeviceFileGeodataPreview,
  })),
);

const DeviceFileMediaPreview = lazy(() =>
  import('./DeviceFileMediaPreview').then((module) => ({ default: module.DeviceFileMediaPreview })),
);

function ContentLoading() {
  return (
    <div className="grid h-full place-items-center">
      <CircularProgress aria-label="Завантаження вмісту файлу" />
    </div>
  );
}

function FilePreview({
  preview,
  zoom,
}: {
  preview: ReturnType<typeof useDeviceFilePreview>;
  zoom: number;
}) {
  if (!preview.source || !preview.signal) return null;
  const lifecycle = {
    signal: preview.signal,
    onError: preview.onError,
    registerCleanup: preview.registerCleanup,
    isCurrent: preview.isCurrent,
  };
  const kind = getFilePreviewKind(preview.source);
  if (kind === 'audio' || kind === 'video')
    return (
      <DeviceFileMediaPreview
        source={preview.source}
        kind={kind}
        lifecycle={lifecycle}
        checkAccess={preview.checkAccess}
        onRetry={preview.retry}
      />
    );
  if (kind === 'converted-map')
    return <DeviceFileGeodataPreview source={preview.source} lifecycle={lifecycle} />;
  if (kind === 'zip')
    return (
      <ZipFilePreview
        source={preview.source}
        lifecycle={lifecycle}
        checkAccess={preview.checkAccess}
      />
    );
  if (kind === 'map')
    return (
      <MapFilePreview
        source={preview.source}
        format={
          preview.source.extension === 'kml' || preview.source.contentType.includes('kml')
            ? 'kml'
            : 'kmz'
        }
        lifecycle={lifecycle}
      />
    );
  if (kind === 'image')
    return <DeviceFileImagePreview source={preview.source} lifecycle={lifecycle} />;
  return <DocumentFilePreview source={preview.source} lifecycle={lifecycle} zoom={zoom} />;
}

function FilePreviewState({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-echo-lg p-echo-2xl text-center">
      <div className="flex size-16 shrink-0 items-center justify-center rounded-echo-xl bg-echo-surface text-echo-text/60">
        {icon}
      </div>
      <h3 className="m-0 text-[22px]! font-medium! text-echo-text">{title}</h3>
      <p className="m-0 text-echo-base leading-relaxed text-echo-text/60">{children}</p>
    </div>
  );
}

function SelectedFileContent({
  preview,
  zoom,
}: {
  preview: ReturnType<typeof useDeviceFilePreview>;
  zoom: number;
}) {
  if (preview.state === 'idle') {
    return (
      <FilePreviewState icon={<PendingActionsOutlinedIcon />} title="Контент файлу відсутній">
        Вміст цього файлу ще не завантажено в Echo.
        <br />
        Перегляд і скачування поки недоступні.
      </FilePreviewState>
    );
  }
  if (preview.state === 'loading') return <ContentLoading />;
  if (preview.state === 'denied' || preview.state === 'transient-error') {
    return (
      <div className="p-echo-md">
        <PowerAlert
          severity="error"
          autoHideDuration={null}
          action={
            preview.state === 'transient-error' && preview.errorRetryable ? (
              <PowerButton onClick={preview.retry}>Повторити</PowerButton>
            ) : undefined
          }
        >
          {preview.error}
        </PowerAlert>
      </div>
    );
  }
  if (preview.state === 'empty') {
    return (
      <FilePreviewState icon={<InsertDriveFileOutlinedIcon />} title="Файл порожній">
        Файл не містить даних.
      </FilePreviewState>
    );
  }
  const extension = preview.source?.extension ?? '';
  const kind = preview.source ? getFilePreviewKind(preview.source) : 'unsupported';
  if (
    kind === 'document' ||
    kind === 'image' ||
    kind === 'zip' ||
    kind === 'map' ||
    kind === 'converted-map' ||
    kind === 'audio' ||
    kind === 'video'
  ) {
    return (
      <Suspense fallback={<ContentLoading />}>
        <FilePreview key={preview.epoch} preview={preview} zoom={zoom} />
      </Suspense>
    );
  }
  return (
    <FilePreviewState
      icon={extension === 'zip' ? <FolderZipOutlinedIcon /> : <InsertDriveFileOutlinedIcon />}
      title={
        extension
          ? `Перегляд формату ${extension.toUpperCase()} не підтримується`
          : 'Перегляд цього формату не підтримується'
      }
    >
      Ви можете скачати файл і відкрити його
      <br />
      на комп’ютері у відповідній програмі.
    </FilePreviewState>
  );
}

function SelectedFilePane({
  deviceId,
  file,
  sessionScoped,
  revisionPinned = false,
  citation,
  mobile,
}: {
  deviceId: string;
  file: DeviceFileSelection;
  sessionScoped: boolean;
  revisionPinned?: boolean;
  citation?: AiAgentFileCitation;
  mobile: boolean;
}) {
  const preview = useDeviceFilePreview({ deviceId, file });
  const [zoom, setZoom] = useState(100);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    setZoom(100);
    setFullscreen(false);
  }, [preview.epoch]);
  useEffect(() => {
    if (preview.state !== 'ready') setFullscreen(false);
  }, [preview.state]);
  const zoomable =
    preview.source &&
    getFilePreviewKind(preview.source) === 'document' &&
    getDocumentPreviewCapabilities(getDocumentFileKind(preview.source)).zoomable;
  const content = <SelectedFileContent preview={preview} zoom={zoom} />;
  return (
    <>
      <DeviceFileContentHeader
        file={file}
        preview={preview}
        sessionScoped={sessionScoped}
        revisionPinned={revisionPinned}
        mobile={mobile}
        zoom={zoomable ? zoom : undefined}
        onZoomChange={setZoom}
        onFullscreen={() => setFullscreen(true)}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-echo-background/50">
        {(preview.state === 'ready' || preview.state === 'empty') &&
          !file.archiveMember &&
          file.kind === 'file' &&
          file.fileId &&
          file.revision != null && (
            <DeviceDocumentDetails
              key={`${deviceId}/${file.fileId}/${file.revision}/${preview.epoch}`}
              lifecycle={
                preview.signal
                  ? {
                      signal: preview.signal,
                      onError: preview.onError,
                      registerCleanup: preview.registerCleanup,
                      isCurrent: preview.isCurrent,
                    }
                  : undefined
              }
              source={
                citation ?? {
                  deviceId,
                  fileId: file.fileId,
                  revision: file.revision,
                  extractionRevision: null,
                  section: null,
                }
              }
            />
          )}
        {!fullscreen && content}
      </div>
      <FilePreviewDialog
        open={fullscreen}
        title={file.name}
        onClose={() => setFullscreen(false)}
        fullScreen={mobile}
        actions={
          <DeviceFileContentActions
            preview={preview}
            mobile={mobile}
            zoom={zoomable ? zoom : undefined}
            onZoomChange={setZoom}
          />
        }
      >
        {content}
      </FilePreviewDialog>
    </>
  );
}

export function DeviceFileContentPane({
  deviceId,
  file,
  sessionScoped = false,
  revisionPinned = false,
  citation,
  mobile = false,
}: {
  deviceId: string;
  file: DeviceFileSelection | null;
  sessionScoped?: boolean;
  revisionPinned?: boolean;
  citation?: AiAgentFileCitation;
  mobile?: boolean;
}) {
  return (
    <section
      aria-labelledby="device-file-content-title"
      data-testid="device-file-content-pane"
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      {file !== null ? (
        <PowerSnackbarProvider>
          <SelectedFilePane
            deviceId={deviceId}
            file={file}
            sessionScoped={sessionScoped}
            revisionPinned={revisionPinned}
            citation={citation}
            mobile={mobile}
          />
        </PowerSnackbarProvider>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-echo-sm p-echo-xl text-center">
          <h2
            id="device-file-content-title"
            className="m-0 break-all text-echo-lg font-semibold text-echo-text"
          >
            Вміст файлу
          </h2>
          <p className="m-0 text-echo-sm text-echo-text-muted">
            Виберіть файл у дереві або результатах пошуку.
          </p>
        </div>
      )}
    </section>
  );
}
