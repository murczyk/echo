import { ButtonBase } from '@mui/material';
import { useCallback, useMemo, type ReactNode } from 'react';

import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import type { DeviceFilesState } from '../use-device-files';
import { formatDeviceFileSize } from '../helpers';
import { isDeviceFolder } from '../device-file-archive';
import { formatDeviceDateTime } from '../../devices/helpers';
import { FileFavoriteButton, FileViewedButton } from './DeviceFileEntryControls';
import { DeviceFileTable } from './DeviceFileTable';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { createThumbnailRequestScheduler } from '../../shared/thumbnail-request-scheduler';
import { DEVICE_FILE_THUMBNAIL_CONCURRENT_REQUESTS } from '../device-file-preview-config';
import { DeviceFileThumbnail } from './DeviceFileThumbnail';

const fileDateFormatter = new Intl.DateTimeFormat('uk-UA');
function fileDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : fileDateFormatter.format(date);
}

function FileDates({ entry }: { entry: DeviceFileTreeEntry }) {
  return (
    <span className="flex w-full flex-col text-[length:var(--echo-typography-font-size-xs)] leading-snug text-echo-text-muted">
      <span
        className="truncate"
        title={`Створено: ${formatDeviceDateTime(entry.fileMetadataCreatedAt)}`}
      >
        Створено: {fileDate(entry.fileMetadataCreatedAt)}
      </span>
      <span
        className="truncate"
        title={`Змінено: ${formatDeviceDateTime(entry.fileMetadataModifiedAt)}`}
      >
        Змінено: {fileDate(entry.fileMetadataModifiedAt)}
      </span>
    </span>
  );
}

export function DeviceFileCards({
  deviceId,
  entries,
  viewMode,
  onOpen,
  onFavorite,
  favoritePending,
  onViewed,
  viewedPending,
  showPath = false,
  fileCounts,
  sorting,
  onSort,
  footer,
  loadingMore = false,
}: {
  deviceId: string;
  entries: DeviceFileTreeEntry[];
  viewMode: 'grid' | 'list';
  favoritePending?: Set<string>;
  onViewed?: (entry: DeviceFileTreeEntry) => void;
  viewedPending?: Set<string>;
  showPath?: boolean;
  fileCounts?: Record<string, number>;
  sorting?: DeviceFilesState['sorting'];
  onSort?: DeviceFilesState['selectSort'];
  footer?: ReactNode;
  loadingMore?: boolean;
  onOpen: (entry: DeviceFileTreeEntry) => void;
  onFavorite: (entry: DeviceFileTreeEntry) => void;
}) {
  const scheduler = useMemo(
    () => createThumbnailRequestScheduler(DEVICE_FILE_THUMBNAIL_CONCURRENT_REQUESTS),
    [deviceId],
  );
  const failures = useMemo(
    () => new Set<number | null>(),
    [deviceId, entries[0]?.parentEntryId, viewMode],
  );
  const { notify } = useOptionalPowerSnackbar();
  const onThumbnailFailure = useCallback(
    (status: number | null) => {
      if (status === 401 || failures.has(status)) return;
      failures.add(status);
      notify({
        severity: 'warning',
        message:
          status === 403 || status === 404
            ? 'Мініатюри деяких файлів недоступні. Перевірте доступ до файлів.'
            : 'Не вдалося завантажити мініатюри деяких файлів. Їх можна відкрити звичайним способом.',
      });
    },
    [failures, notify],
  );
  if (viewMode === 'list')
    return (
      <DeviceFileTable
        entries={entries}
        onOpen={onOpen}
        onFavorite={onFavorite}
        favoritePending={favoritePending}
        onViewed={onViewed}
        viewedPending={viewedPending}
        showPath={showPath}
        sorting={sorting}
        onSort={onSort}
        footer={footer}
        loadingMore={loadingMore}
      />
    );
  return (
    <ul
      aria-label="Файли та папки"
      className="m-0 grid auto-rows-fr list-none grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] items-stretch gap-echo-md p-0"
    >
      {entries.map((entry) => {
        const directory = isDeviceFolder(entry);
        const fileCount =
          entry.kind === 'directory' && !entry.archiveOrigin
            ? fileCounts?.[entry.entryId]
            : undefined;
        return (
          <li
            key={entry.entryId}
            data-entry-id={entry.entryId}
            className={`relative flex min-w-0 flex-col rounded-echo-md border border-echo-primary/60 bg-echo-surface ${directory || entry.hasContent ? '' : 'opacity-55'}`}
          >
            <ButtonBase
              onClick={() => onOpen(entry)}
              aria-label={`Відкрити ${directory ? 'папку' : 'файл'} ${entry.name}`}
              aria-description={
                directory || entry.hasContent ? undefined : 'Контент файлу відсутній'
              }
              className="h-full! min-h-44! w-full! min-w-0! flex-col! gap-echo-sm! rounded-echo-md! p-echo-sm! focus-visible:outline focus-visible:outline-echo-focus"
            >
              <DeviceFileThumbnail
                deviceId={deviceId}
                entry={entry}
                scheduler={scheduler}
                onFailure={onThumbnailFailure}
              />
              <span className="flex w-full min-w-0 flex-1 flex-col items-center gap-echo-xs text-center">
                <span
                  className="block w-full max-w-full truncate text-[length:var(--echo-typography-font-size-base)] leading-snug font-normal!"
                  title={entry.name}
                >
                  {entry.name}
                </span>
                {showPath && (
                  <span
                    className="max-w-full truncate text-[length:var(--echo-typography-font-size-xs)] text-echo-text-muted"
                    title={entry.absolutePath ?? entry.pathComponents.join(' / ')}
                  >
                    {entry.absolutePath ?? entry.pathComponents.join(' / ')}
                  </span>
                )}
                <span className="flex w-full flex-col items-center gap-echo-xs text-[length:var(--echo-typography-font-size-xs)] leading-snug text-echo-text-muted">
                  {entry.kind === 'directory' &&
                    (fileCount !== undefined || entry.sizeBytes != null) && (
                      <span
                        className="max-w-full truncate"
                        title="Файли та розмір цієї папки й вкладених папок"
                      >
                        {fileCount !== undefined
                          ? `Файлів: ${fileCount.toLocaleString('uk-UA')}`
                          : ''}
                        {fileCount !== undefined && entry.sizeBytes != null ? ' · ' : ''}
                        {entry.sizeBytes != null ? formatDeviceFileSize(entry.sizeBytes) : ''}
                      </span>
                    )}
                  <FileDates entry={entry} />
                </span>
              </span>
            </ButtonBase>
            {!directory && (
              <span className="absolute left-echo-xs top-echo-xs inline-flex min-h-7 min-w-7 items-center justify-center rounded-full bg-echo-surface/90">
                <FileViewedButton
                  entry={entry}
                  onViewed={onViewed}
                  pending={viewedPending?.has(`${entry.fileId}/${entry.revision}`)}
                  newLabel="нове"
                />
              </span>
            )}
            <FileFavoriteButton
              entry={entry}
              onFavorite={onFavorite}
              pending={favoritePending?.has(entry.entryId)}
              className="absolute! right-echo-xs! top-echo-xs! bg-echo-surface/90!"
            />
          </li>
        );
      })}
    </ul>
  );
}
