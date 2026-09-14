import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import { CircularProgress, Link } from '@mui/material';

import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { formatDeviceDateTime } from '../../devices/helpers';
import type { DeviceFileLoadError } from '../types';
import { DeviceAnalyticsTagBadges } from './DeviceAnalyticsTagBadges';
import { DeviceFileContentMarker } from './DeviceFileContentMarker';

type Props = {
  entries: DeviceFileTreeEntry[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  error: DeviceFileLoadError | null;
  loadMoreError: DeviceFileLoadError | null;
  onOpenDirectory: (entryId: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
};

function FileEntryMetadata({ entry }: { entry: DeviceFileTreeEntry }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-x-echo-sm gap-y-echo-xs text-echo-xs text-echo-text-muted">
      <span>MIME: {entry.mimeType ?? '—'}</span>
      <span>Розширення: {entry.extension ?? '—'}</span>
      <span>Змінено у джерелі: {formatDeviceDateTime(entry.fileMetadataModifiedAt)}</span>
      <span>Оновлено в ЕХО: {formatDeviceDateTime(entry.updatedAt)}</span>
    </div>
  );
}

function DeviceFileSearchResultRow({
  entry,
  onOpenDirectory,
}: {
  entry: DeviceFileTreeEntry;
  onOpenDirectory: (entryId: string) => void;
}) {
  const directory = entry.kind === 'directory';
  const pathLabel = entry.absolutePath ?? (entry.pathComponents.join(' / ') || '—');

  return (
    <li data-entry-id={entry.entryId} className="min-w-0 space-y-echo-xs px-echo-sm py-echo-md">
      <div className="flex min-w-0 items-start gap-echo-sm">
        {directory ? (
          <FolderOpenOutlinedIcon className="mt-echo-xs shrink-0 text-echo-primary" />
        ) : (
          <InsertDriveFileOutlinedIcon className="mt-echo-xs shrink-0 text-echo-text-muted" />
        )}
        <div className="min-w-0 flex-1">
          {directory ? (
            <Link
              component="button"
              type="button"
              underline="hover"
              fontWeight={600}
              className="block max-w-full text-left [overflow-wrap:anywhere]"
              onClick={() => onOpenDirectory(entry.entryId)}
            >
              {entry.name}
            </Link>
          ) : (
            <span
              className="block max-w-full truncate text-echo-sm font-semibold text-echo-text"
              title={entry.name}
            >
              {entry.name}
            </span>
          )}
        </div>
        {!directory ? (
          <div className="flex shrink-0 items-center">
            <DeviceFileContentMarker hasContent={entry.hasContent} />
          </div>
        ) : null}
      </div>
      <code className="block min-w-0 break-words text-echo-xs text-echo-text-muted [overflow-wrap:anywhere]">
        {pathLabel}
      </code>
      {!directory ? <DeviceAnalyticsTagBadges tags={entry.tags} /> : null}
      <FileEntryMetadata entry={entry} />
    </li>
  );
}

export function DeviceFileSearchResults({
  entries,
  loading,
  refreshing,
  loadingMore,
  nextCursor,
  error,
  loadMoreError,
  onOpenDirectory,
  onRetry,
  onLoadMore,
}: Props) {
  return (
    <section aria-label="Результати пошуку файлів" className="min-w-0 space-y-echo-md">
      {error ? (
        <PowerAlert
          severity="error"
          autoHideDuration={null}
          action={
            <PowerButton size="small" onClick={onRetry}>
              Повторити
            </PowerButton>
          }
        >
          {error.message}
        </PowerAlert>
      ) : null}

      {loading ? (
        <div className="grid min-h-40 place-items-center">
          <CircularProgress size={28} aria-label="Завантаження файлів" />
        </div>
      ) : entries.length === 0 && error === null ? (
        <div className="rounded-echo-md border border-echo-border p-echo-lg text-center text-echo-sm text-echo-text-muted">
          За заданими фільтрами нічого не знайдено.
        </div>
      ) : (
        <ul
          className={`m-0 min-w-0 divide-y divide-echo-divider overflow-hidden rounded-echo-md border border-echo-border bg-echo-surface p-0 ${refreshing ? 'opacity-60' : ''}`}
          aria-busy={refreshing}
        >
          {entries.map((entry) => (
            <DeviceFileSearchResultRow
              key={entry.entryId}
              entry={entry}
              onOpenDirectory={onOpenDirectory}
            />
          ))}
        </ul>
      )}

      {loadMoreError ? (
        <PowerAlert
          severity="error"
          autoHideDuration={null}
          action={
            <PowerButton size="small" onClick={onLoadMore}>
              Повторити
            </PowerButton>
          }
        >
          {loadMoreError.message}
        </PowerAlert>
      ) : null}

      {nextCursor !== null ? (
        <div className="flex justify-center">
          <PowerButton variant="outlined" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Завантаження…' : 'Завантажити ще'}
          </PowerButton>
        </div>
      ) : null}
    </section>
  );
}
