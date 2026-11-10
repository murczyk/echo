import { useEffect, useState } from 'react';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { archiveMemberSelection, type DeviceFileSelection } from '../device-file-archive';
import { useDeviceFileViewMode } from '../use-device-file-view-mode';
import { useDeviceArchive } from '../use-device-archive';
import { useDeviceDirectory } from '../use-device-directory';
import { useDeviceFileMarkers } from '../use-device-file-markers';
import { DeviceFileFolderContent } from './DeviceFileFolderContent';
import { DeviceFileViewMode } from './DeviceFileExplorerToolbar';

export type DeviceArchiveExplorerOptions = {
  viewMode: 'grid' | 'list';
  setViewMode: (mode: 'grid' | 'list') => void;
  markers: ReturnType<typeof useDeviceFileMarkers>;
};

export function DeviceArchiveExplorer({
  deviceId,
  file,
  options,
  onSelectFile,
  onOpenDirectory,
  onReady,
}: {
  deviceId: string;
  file: DeviceFileSelection;
  options?: DeviceArchiveExplorerOptions;
  onSelectFile: (file: DeviceFileSelection) => void;
  onOpenDirectory?: (entryId: string, revision: number | null) => void;
  onReady?: (entryId: string, revision: number) => void;
}) {
  const archive = useDeviceArchive(deviceId, file, true);
  const fallbackMarkers = useDeviceFileMarkers(deviceId, null);
  const markers = options?.markers ?? fallbackMarkers;
  const [localViewMode, setLocalViewMode] = useDeviceFileViewMode();
  const [parents, setParents] = useState<string[]>([]);
  const viewMode = options?.viewMode ?? localViewMode;
  const state = archive.summary?.state;
  const ready = !archive.denied && state === 'ready' && Boolean(archive.summary?.archiveId);
  const prepared = ready && archive.status?.archive.state === 'ready';
  useEffect(() => {
    if (prepared && file.revision != null) onReady?.(file.entryId, file.revision);
  }, [prepared, file.entryId, file.revision, onReady]);
  const directory = useDeviceDirectory({
    deviceId,
    entryId: parents.at(-1) ?? file.fileId,
    archiveRevision: file.revision,
    enabled: ready && !onReady,
    roots: [],
    tagFilter: { tagIds: [], tagMatch: 'any', untagged: false },
  });
  const { notify } = useOptionalPowerSnackbar();
  const error = directory.error?.message ?? markers.error;
  useEffect(() => {
    if (error) notify({ severity: 'error', message: error });
  }, [error, notify]);
  if (!ready) return <DeviceArchivePreparation archive={archive} file={file} />;
  if (onReady) return null;
  return (
    <DeviceFileFolderContent
      deviceId={deviceId}
      entries={directory.entries.map(markers.withMarkers)}
      viewMode={viewMode}
      loading={directory.loading}
      loadingMore={directory.loadingMore}
      error={archive.error ?? error}
      nextCursor={directory.nextCursor}
      scrollPositions={directory.scrollPositions}
      onRetry={() => {
        if (directory.error && directory.entries.length > 0 && directory.nextCursor !== null) {
          void directory.loadMore();
          return;
        }
        archive.retry();
        void directory.refresh();
      }}
      onLoadMore={() => void directory.loadMore()}
      active={!directory.refreshing}
      onOpen={(entry) => {
        if (entry.kind === 'directory') {
          if (onOpenDirectory) onOpenDirectory(entry.entryId, entry.revision ?? file.revision);
          else setParents((current) => [...current, entry.entryId]);
        } else onSelectFile(archiveMemberSelection(file, entry));
      }}
      onFavorite={markers.toggleFavorite}
      favoritePending={markers.pending}
      onViewed={markers.toggleViewed}
      viewedPending={markers.viewedPending}
    >
      <div className="flex items-center justify-end gap-echo-xs">
        {parents.length > 0 && (
          <PowerButton
            className="mr-auto!"
            onClick={() => setParents((current) => current.slice(0, -1))}
          >
            До папки
          </PowerButton>
        )}
        <DeviceFileViewMode
          viewMode={viewMode}
          onChange={options?.setViewMode ?? setLocalViewMode}
        />
      </div>
    </DeviceFileFolderContent>
  );
}

function DeviceArchivePreparation({
  archive,
  file,
}: {
  archive: ReturnType<typeof useDeviceArchive>;
  file: DeviceFileSelection;
}) {
  const state = archive.summary?.state;
  const hasContent = archive.status ? state !== 'missing_content' : file.hasContent;
  const message = !hasContent
    ? 'Контент файлу відсутній'
    : state === 'failed'
      ? `${archive.summary?.message ?? 'Не вдалося підготувати архів'}${archive.summary?.limitName ? ` (${archive.summary.limitName})` : ''}`
      : state === 'queued'
        ? 'Очікує підготовки'
        : state === 'retry_wait'
          ? 'Тимчасова помилка сховища. Очікується повторна спроба'
          : 'Готується';
  return (
    <div className="space-y-echo-md p-echo-lg">
      {archive.error && (
        <PowerAlert
          severity="error"
          autoHideDuration={null}
          action={<PowerButton onClick={archive.retry}>Повторити читання</PowerButton>}
        >
          {archive.error}
        </PowerAlert>
      )}
      {!archive.denied && (
        <div role="status">
          {message}
          {state === 'retry_wait' && archive.status?.nextAttemptAt && (
            <>
              {' — '}
              <time dateTime={archive.status.nextAttemptAt}>
                {new Date(archive.status.nextAttemptAt).toLocaleString('uk-UA')}
              </time>
            </>
          )}
        </div>
      )}
    </div>
  );
}
