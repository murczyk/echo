import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import { ButtonBase, CircularProgress, Tooltip } from '@mui/material';

import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';
import type { DeviceFileLoadError, DeviceFileScrollPositions } from '../types';
import { useDeviceFileScroll } from '../use-device-file-scroll';
import { DeviceFileIcon } from './DeviceFileIcon';
import { FileViewedButton } from './DeviceFileEntryControls';
import { DeviceFileAutoLoad } from './DeviceFileAutoLoad';
import { DeviceFileTableSkeletons } from './DeviceFileLoadingSkeletons';

type Props = {
  entries: DeviceFileTreeEntry[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  error: DeviceFileLoadError | null;
  loadMoreError: DeviceFileLoadError | null;
  active?: boolean;
  scrollPositions?: DeviceFileScrollPositions;
  onOpenDirectory: (entryId: string, revision?: number | null) => void;
  onSelectFile: (entry: DeviceFileTreeEntry) => void;
  onOpenParent?: (entry: DeviceFileTreeEntry) => void;
  onViewed?: (entry: DeviceFileTreeEntry) => void;
  viewedPending?: Set<string>;
  onRetry: () => void;
  onLoadMore: () => void;
};

function parentPath(entry: DeviceFileTreeEntry) {
  const absolute = entry.virtualPath ?? entry.absolutePath;
  if (absolute) {
    const end = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'));
    return end < 0 ? '—' : absolute.slice(0, end + (end === 2 || end === 0 ? 1 : 0));
  }
  const parts = entry.pathComponents.slice(0, -1);
  if (parts.length < 2) return parts[0] || '—';
  return /^[a-z]:/i.test(parts[0])
    ? parts[0].replace(/[\\/]$/, '') + '\\' + parts.slice(1).join('\\')
    : parts.join(' / ');
}

type RowProps = Pick<
  Props,
  'onOpenDirectory' | 'onSelectFile' | 'onOpenParent' | 'onViewed' | 'viewedPending'
> & { entry: DeviceFileTreeEntry };

function DeviceFileSearchResultRow({
  entry,
  onOpenDirectory,
  onSelectFile,
  onOpenParent,
  onViewed,
  viewedPending,
}: RowProps) {
  const path = parentPath(entry);
  const directory = entry.kind === 'directory';
  return (
    <tr
      key={entry.entryId}
      data-entry-id={entry.entryId}
      className={`even:bg-echo-surface/40 ${directory || entry.hasContent ? '' : 'opacity-55'}`}
    >
      <td className="px-echo-sm py-echo-sm">
        <div className="flex min-w-0 items-center gap-echo-sm">
          <ButtonBase
            className="flex! w-full! min-w-0! justify-start! gap-echo-sm! text-left! text-[length:var(--echo-typography-font-size-base)]!"
            title={entry.name}
            aria-description={
              !directory && !entry.hasContent ? 'Контент файлу відсутній' : undefined
            }
            onClick={() =>
              directory
                ? onOpenDirectory(entry.entryId, entry.archiveOrigin ? entry.revision : null)
                : onSelectFile(entry)
            }
          >
            <DeviceFileIcon entry={entry} fontSize="small" />
            <span className="truncate">{entry.name}</span>
          </ButtonBase>
          {!directory && (
            <FileViewedButton
              entry={entry}
              onViewed={onViewed}
              pending={viewedPending?.has(`${entry.fileId}/${entry.revision}`)}
            />
          )}
        </div>
      </td>
      <td title={path} className="truncate px-echo-sm py-echo-sm text-echo-text-muted">
        {path || '—'}
      </td>
      <td className="whitespace-nowrap px-echo-sm py-echo-xs">
        <Tooltip title="Перейти до папки">
          <PowerIconButton
            size="small"
            aria-label={`Перейти до папки: ${entry.name}`}
            onClick={() => onOpenParent?.(entry)}
          >
            <FolderOpenOutlinedIcon fontSize="small" />
          </PowerIconButton>
        </Tooltip>
      </td>
    </tr>
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
  active = true,
  scrollPositions,
  onOpenDirectory,
  onSelectFile,
  onOpenParent,
  onViewed,
  viewedPending,
  onRetry,
  onLoadMore,
}: Props) {
  const { viewportRef, onScrollCapture } = useDeviceFileScroll({
    positions: scrollPositions,
    viewMode: 'list',
    loading,
    active,
    tableVisible: false,
  });
  const failure = error ?? loadMoreError;
  return (
    <section
      ref={viewportRef}
      onScrollCapture={onScrollCapture}
      data-device-file-scroll-viewport
      aria-label="Результати пошуку файлів"
      aria-busy={loading || refreshing || loadingMore}
      className="min-h-0 min-w-0 flex-1 overflow-auto"
    >
      {failure && (
        <PowerAlert
          severity="error"
          autoHideDuration={null}
          action={
            <PowerButton onClick={loadMoreError ? onLoadMore : onRetry}>Повторити</PowerButton>
          }
        >
          {failure.message}
        </PowerAlert>
      )}
      {loading ? (
        <div className="grid min-h-40 place-items-center">
          <CircularProgress aria-label="Пошук файлів" />
        </div>
      ) : (
        <table
          aria-label="Результати пошуку"
          className="w-full min-w-[36rem] table-fixed border-separate border-spacing-0 text-[length:var(--echo-typography-font-size-base)]"
        >
          <colgroup>
            <col className="w-1/3" />
            <col />
            <col className="w-16" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-echo-background text-left text-echo-text-muted">
            <tr>
              {['Назва', 'Шлях', 'Дії'].map((label) => (
                <th
                  key={label}
                  scope="col"
                  className="border-b border-echo-border px-echo-sm py-echo-sm font-bold"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <DeviceFileSearchResultRow
                key={entry.entryId}
                entry={entry}
                onOpenDirectory={onOpenDirectory}
                onSelectFile={onSelectFile}
                onOpenParent={onOpenParent}
                onViewed={onViewed}
                viewedPending={viewedPending}
              />
            ))}
            {loadingMore && <DeviceFileTableSkeletons columns={3} />}
          </tbody>
        </table>
      )}
      {!loading && entries.length === 0 && !failure && (
        <p className="p-echo-xl text-center text-echo-text-muted">
          За заданими фільтрами нічого не знайдено.
        </p>
      )}
      {nextCursor !== null && (
        <DeviceFileAutoLoad
          cursor={nextCursor}
          loading={loadingMore}
          enabled={active && !loading && !refreshing && !failure}
          onLoadMore={onLoadMore}
        />
      )}
    </section>
  );
}
