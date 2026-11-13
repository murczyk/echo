import type { AiAgentFileCitation } from '../../../../../Bindings';
import { DeviceFileExplorerToolbar } from './DeviceFileExplorerToolbar';

import { PowerAlert } from '../../../components/PowerAlert';
import { DeviceFileSearchResults } from './DeviceFileSearchResults';
import { DeviceFileFolderContent } from './DeviceFileFolderContent';
import { DeviceFileContentPane } from './DeviceFileContentPane';
import { DeviceFileBreadcrumbs } from './DeviceFileBreadcrumbs';
import { DeviceArchiveDownloadAction } from './DeviceArchiveDownloadAction';
import {
  DeviceFileFavoriteAction,
  useDeviceFilePreviewNavigation,
} from './DeviceFilePreviewNavigation';
import {
  DeviceFileExplorerFilters,
  type DeviceFileExplorerFilterProps,
} from './DeviceFileExplorerFilters';

export function DeviceFileExplorer({
  files,
  sessionScoped = false,
  mobile = false,
  citation,
  ...filters
}: DeviceFileExplorerFilterProps & {
  sessionScoped?: boolean;
  mobile?: boolean;
  citation?: AiAgentFileCitation;
}) {
  const navigation = useDeviceFilePreviewNavigation(files);
  return (
    <>
      <DeviceFileExplorerFolder files={files} {...filters} />
      {files.selectedFile && (
        <div className="flex h-full min-h-0 min-w-0 flex-col pr-[var(--device-files-scroll-gutter,0px)]">
          <div className="min-h-0 min-w-0 flex-1 [--device-files-scroll-gutter:0px]">
            <DeviceFileContentPane
              deviceId={files.deviceId}
              breadcrumbs={files.breadcrumbs}
              archiveOptions={{
                viewMode: files.viewMode,
                setViewMode: files.setViewMode,
                markers: files.markers,
              }}
              navigation={navigation}
              additionalActions={<DeviceFileFavoriteAction files={files} />}
              onClose={files.clearSelectedFile}
              closeLabel={files.searchResultsVisible ? 'До результатів пошуку' : 'До папки'}
              file={files.selectedFile}
              onSelectFile={files.selectFile}
              onOpenDirectory={files.openDirectory}
              onArchiveReady={files.openPreparedArchive}
              sessionScoped={sessionScoped}
              revisionPinned={files.revisionPinned}
              mobile={mobile}
              citation={citation}
            />
          </div>
        </div>
      )}
    </>
  );
}

function DeviceFileExplorerFolder({ files, ...filters }: DeviceFileExplorerFilterProps) {
  const directory = files.directory;
  const atRoots = files.selectedDirectory === null;
  const loading = atRoots ? files.rootsLoading : directory.loading;
  const error = atRoots ? files.rootsError : directory.error;
  const retry = atRoots
    ? files.reloadRoots
    : directory.entries.length > 0 && directory.nextCursor !== null
      ? directory.loadMore
      : directory.refresh;
  return (
    <div className={files.selectedFile ? 'hidden' : 'flex h-full min-h-0 min-w-0 flex-col'}>
      <div
        className={`flex min-h-echo-control-lg min-w-0 shrink-0 items-center gap-echo-sm py-echo-sm pr-[var(--device-files-scroll-gutter,0px)] ${files.searchLocation || files.searchDraft.nameQuery ? 'max-echo-lg:flex-wrap' : ''}`}
      >
        <div
          className={`min-w-0 flex-1 text-[length:var(--echo-typography-font-size-base)] font-semibold ${files.searchLocation || files.searchDraft.nameQuery ? 'max-echo-lg:basis-full' : ''}`}
        >
          <DeviceFileBreadcrumbs
            breadcrumbs={files.searchResultsVisible ? [] : files.breadcrumbs}
          />
        </div>
        <DeviceArchiveDownloadAction
          source={files.selectedFile ? null : directory.archiveSource}
          name={
            directory.breadcrumbs.find((item) => item.entryId === directory.archiveSource?.fileId)
              ?.name
          }
        />
        <DeviceFileExplorerToolbar files={files} />
      </div>
      {files.filtersOpen && <DeviceFileExplorerFilters files={files} {...filters} />}
      {files.searchValidationErrors.nameQuery && (
        <PowerAlert severity="warning" autoHideDuration={null}>
          {files.searchValidationErrors.nameQuery}
        </PowerAlert>
      )}
      {files.searchResultsVisible ? (
        <DeviceFileSearchResults
          entries={files.searchEntries}
          loading={files.searchLoading}
          refreshing={files.searchRefreshing}
          loadingMore={files.searchLoadingMore}
          nextCursor={files.searchNextCursor}
          error={files.searchError}
          loadMoreError={files.searchLoadMoreError}
          active={!files.selectedFile}
          scrollPositions={files.searchScrollPositions}
          onOpenDirectory={files.openDirectory}
          onSelectFile={files.selectFile}
          onOpenParent={files.openSearchParent}
          onViewed={files.toggleViewed}
          viewedPending={files.viewedPending}
          onRetry={() => void files.retrySearch()}
          onLoadMore={() => void files.loadMoreSearch()}
        />
      ) : (
        <DeviceFileFolderContent
          deviceId={files.deviceId}
          entries={directory.entries}
          viewMode={files.viewMode}
          sorting={files.sorting}
          onSort={files.selectSort}
          loading={loading}
          loadingMore={directory.loadingMore}
          error={error?.message ?? null}
          nextCursor={directory.nextCursor}
          scrollPositions={directory.scrollPositions}
          onRetry={() => void retry()}
          onLoadMore={() => void directory.loadMore()}
          active={!files.selectedFile && !directory.refreshing}
          onOpen={(entry) =>
            entry.kind === 'directory'
              ? files.openDirectory(entry.entryId, entry.archiveOrigin ? entry.revision : null)
              : files.selectFile(entry)
          }
          onFavorite={files.toggleFavorite}
          favoritePending={files.favoritePending}
          onViewed={files.toggleViewed}
          viewedPending={files.viewedPending}
          fileCounts={files.counts.countsByEntryId}
          emptyMessage={
            files.favoritesOnly || files.unviewedOnly || files.contentFilter !== null
              ? 'За заданими фільтрами нічого не знайдено.'
              : 'Папка порожня.'
          }
        />
      )}
    </div>
  );
}
