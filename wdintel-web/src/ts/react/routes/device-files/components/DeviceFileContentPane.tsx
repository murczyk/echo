import type { AiAgentFileCitation, FileBreadcrumb } from '../../../../../Bindings';
import { DeviceDocumentDetails } from './DeviceDocumentPreview';
import type { DeviceFileVideoPlayback } from '../types';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import PendingActionsOutlinedIcon from '@mui/icons-material/PendingActionsOutlined';
import { Box, CircularProgress, Typography } from '@mui/material';
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';

import { isDeviceArchive, type DeviceFileSelection } from '../device-file-archive';
import { DeviceArchiveExplorer, type DeviceArchiveExplorerOptions } from './DeviceArchiveExplorer';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerSnackbarProvider } from '../../../components/PowerSnackbar';
import { useDeviceFilePreview } from '../use-device-file-preview';
import { useDeviceFileKeyboardNavigation } from '../use-device-file-keyboard-navigation';
import { DeviceFileContentHeader } from './DeviceFileContentHeader';

import { getNativeMapFormat } from '../../shared/message-card/kmz/kmz-preview-utils';
import { getFilePreviewKind } from '../../shared/message-card/file-preview-kind';
import type { MessageCardPreviewNavigation } from '../../shared/message-card/attachment-preview/message-card-preview.types';
import { FilePreviewDialog } from '../../shared/message-card/attachment-preview/FilePreviewDialog';
import { getAttachmentPreviewStageBg } from '../../shared/message-card/attachment-preview/message-card-attachment-preview';

const DocumentFilePreviewStage = lazy(() =>
  import('../../shared/message-card/renderers/DocumentFilePreviewStage').then((module) => ({
    default: module.DocumentFilePreviewStage,
  })),
);
const DeviceFileImagePreview = lazy(() =>
  import('./DeviceFileImagePreview').then((module) => ({ default: module.DeviceFileImagePreview })),
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
  onZoomChange,
  videoPlayback,
}: {
  preview: ReturnType<typeof useDeviceFilePreview>;
  zoom: number;
  onZoomChange: Dispatch<SetStateAction<number>>;
  videoPlayback?: DeviceFileVideoPlayback | null;
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
        videoPlayback={videoPlayback}
        lifecycle={lifecycle}
        checkAccess={preview.checkAccess}
        onRetry={preview.retry}
        onDurationChange={preview.onDurationChange}
      />
    );
  if (kind === 'converted-map')
    return <DeviceFileGeodataPreview source={preview.source} lifecycle={lifecycle} />;
  if (kind === 'map')
    return (
      <MapFilePreview
        source={preview.source}
        format={
          getNativeMapFormat(preview.source.fileName, preview.source.contentType) ??
          getNativeMapFormat(`file.${preview.source.extension}`) ??
          'kmz'
        }
        lifecycle={lifecycle}
      />
    );
  if (kind === 'image')
    return (
      <DeviceFileImagePreview
        source={preview.source}
        lifecycle={lifecycle}
        onImageLoad={preview.onImageLoad}
      />
    );
  return (
    <DocumentFilePreviewStage
      source={preview.source}
      lifecycle={lifecycle}
      zoom={zoom}
      onZoomChange={onZoomChange}
    />
  );
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
      <Typography component="h3" variant="subtitle1" className="m-0! font-semibold! text-echo-text">
        {title}
      </Typography>
      <Typography component="p" variant="body2" className="m-0! text-echo-text/60">
        {children}
      </Typography>
    </div>
  );
}

function SelectedFileContent({
  preview,
  zoom,
  onZoomChange,
  videoPlayback,
}: {
  preview: ReturnType<typeof useDeviceFilePreview>;
  zoom: number;
  onZoomChange: Dispatch<SetStateAction<number>>;
  videoPlayback?: DeviceFileVideoPlayback | null;
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
  return (
    <Suspense fallback={<ContentLoading />}>
      <FilePreview
        key={preview.epoch}
        preview={preview}
        zoom={zoom}
        onZoomChange={onZoomChange}
        videoPlayback={videoPlayback}
      />
    </Suspense>
  );
}

function SelectedFilePane({
  paneRef,
  deviceId,
  file,
  breadcrumbs,
  sessionScoped,
  revisionPinned = false,
  citation,
  showDocumentDetails,
  onSelectFile,
  onOpenDirectory,
  onArchiveReady,
  archiveOptions,
  navigation,
  additionalActions,
  onClose,
  closeLabel = 'До папки',
}: {
  paneRef: RefObject<HTMLElement>;
  deviceId: string;
  file: DeviceFileSelection;
  breadcrumbs?: FileBreadcrumb[];
  sessionScoped: boolean;
  revisionPinned?: boolean;
  citation?: AiAgentFileCitation;
  showDocumentDetails: boolean;
  onSelectFile: (file: DeviceFileSelection) => void;
  onOpenDirectory?: (entryId: string, revision: number | null) => void;
  archiveOptions?: DeviceArchiveExplorerOptions;
  onArchiveReady?: (entryId: string, revision: number) => void;
  navigation?: MessageCardPreviewNavigation;
  additionalActions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
}) {
  const preview = useDeviceFilePreview({ deviceId, file });
  const [zoom, setZoom] = useState(100);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenContentRef = useRef<HTMLDivElement>(null);
  const videoPlayback = useRef<{ epoch: number | null; state: DeviceFileVideoPlayback } | null>(
    null,
  );
  const changeFullscreen = (next: boolean) => {
    const container = fullscreen ? fullscreenContentRef.current : paneRef.current;
    const video = container?.querySelector('video');
    if (preview.source && video && video.readyState >= 1) {
      videoPlayback.current = {
        epoch: preview.epoch,
        state: {
          sourceKey: preview.source.key,
          currentTime: video.currentTime,
          paused: video.paused || video.ended,
          volume: video.volume,
          muted: video.muted,
          playbackRate: video.playbackRate,
        },
      };
    }
    setFullscreen(next);
  };
  useDeviceFileKeyboardNavigation({
    paneRef,
    fullscreenContentRef,
    fullscreen,
    navigation,
    enabled: preview.state !== 'denied',
  });
  useEffect(() => {
    setZoom(100);
  }, [preview.epoch]);
  useEffect(() => {
    if (
      preview.state === 'denied' ||
      preview.state === 'transient-error' ||
      preview.state === 'idle'
    )
      setFullscreen(false);
  }, [preview.state]);
  const archive = isDeviceArchive(file);
  const content = archive ? (
    <DeviceArchiveExplorer
      key={`${deviceId}/${file.fileId}/${file.revision}`}
      deviceId={deviceId}
      file={file}
      options={archiveOptions}
      onSelectFile={onSelectFile}
      onOpenDirectory={onOpenDirectory}
      onReady={onArchiveReady}
    />
  ) : (
    <SelectedFileContent
      preview={preview}
      zoom={zoom}
      onZoomChange={setZoom}
      videoPlayback={
        videoPlayback.current?.epoch === preview.epoch ? videoPlayback.current.state : null
      }
    />
  );
  return (
    <>
      <DeviceFileContentHeader
        file={file}
        breadcrumbs={breadcrumbs}
        preview={preview}
        sessionScoped={sessionScoped}
        revisionPinned={revisionPinned}
        navigation={navigation}
        additionalActions={additionalActions}
        onClose={onClose}
        closeLabel={closeLabel}
        onFullscreen={() => changeFullscreen(true)}
      />
      <Box
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto"
        sx={{ backgroundColor: getAttachmentPreviewStageBg }}
      >
        {showDocumentDetails &&
          (preview.state === 'ready' || preview.state === 'empty') &&
          !archive &&
          !file.archiveOrigin &&
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
      </Box>
      <FilePreviewDialog
        open={fullscreen}
        title={file.name}
        onClose={() => changeFullscreen(false)}
        fullScreen
        header={
          <DeviceFileContentHeader
            file={file}
            breadcrumbs={breadcrumbs}
            preview={preview}
            titleId="device-file-fullscreen-title"
            sessionScoped={sessionScoped}
            revisionPinned={revisionPinned}
            navigation={navigation}
            additionalActions={additionalActions}
            onClose={() => changeFullscreen(false)}
            closeLabel="Закрити перегляд"
          />
        }
      >
        <Box
          ref={fullscreenContentRef}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto"
          sx={{ backgroundColor: getAttachmentPreviewStageBg }}
        >
          {content}
        </Box>
      </FilePreviewDialog>
    </>
  );
}

export function DeviceFileContentPane({
  deviceId,
  file,
  breadcrumbs,
  onSelectFile,
  onOpenDirectory,
  onArchiveReady,
  archiveOptions,
  navigation,
  additionalActions,
  onClose,
  closeLabel = 'До папки',
  sessionScoped = false,
  revisionPinned = false,
  citation,
  showDocumentDetails = false,
}: {
  deviceId: string;
  file: DeviceFileSelection | null;
  breadcrumbs?: FileBreadcrumb[];
  onSelectFile?: (file: DeviceFileSelection) => void;
  onOpenDirectory?: (entryId: string, revision: number | null) => void;
  archiveOptions?: DeviceArchiveExplorerOptions;
  onArchiveReady?: (entryId: string, revision: number) => void;
  navigation?: MessageCardPreviewNavigation;
  additionalActions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  sessionScoped?: boolean;
  revisionPinned?: boolean;
  citation?: AiAgentFileCitation;
  showDocumentDetails?: boolean;
  mobile?: boolean;
}) {
  const paneRef = useRef<HTMLElement>(null);
  const key = `${deviceId}/${file?.fileId}/${file?.revision}`;
  const [selection, setSelection] = useState<{ key: string; file: DeviceFileSelection } | null>(
    null,
  );
  useEffect(() => setSelection(null), [key, file]);
  const selected = !onSelectFile && selection?.key === key ? selection.file : file;
  return (
    <section
      ref={paneRef}
      aria-labelledby="device-file-content-title"
      data-testid="device-file-content-pane"
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      {selected !== null ? (
        <PowerSnackbarProvider>
          <SelectedFilePane
            paneRef={paneRef}
            deviceId={deviceId}
            file={selected}
            breadcrumbs={breadcrumbs}
            onSelectFile={onSelectFile ?? ((file) => setSelection({ key, file }))}
            onOpenDirectory={onOpenDirectory}
            onArchiveReady={onArchiveReady}
            archiveOptions={archiveOptions}
            navigation={navigation}
            additionalActions={additionalActions}
            onClose={onClose}
            closeLabel={closeLabel}
            sessionScoped={sessionScoped}
            revisionPinned={revisionPinned}
            citation={citation}
            showDocumentDetails={showDocumentDetails}
          />
        </PowerSnackbarProvider>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-echo-sm p-echo-xl text-center">
          <h2
            id="device-file-content-title"
            className="m-0 break-all text-[length:var(--echo-typography-font-size-lg)]! font-semibold text-echo-text"
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
