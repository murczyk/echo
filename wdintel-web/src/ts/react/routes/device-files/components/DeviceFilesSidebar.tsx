import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import { CircularProgress, Tooltip } from '@mui/material';
import { useState } from 'react';

import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';
import type { DeviceAnalyticsTagFilter } from '../types';
import type { DeviceAnalyticsTagsState } from '../use-device-analytics-tags';
import type { DeviceFilesState } from '../use-device-files';
import { DeviceFileSearchControls } from './DeviceFileSearchControls';
import { DeviceFileSearchResults } from './DeviceFileSearchResults';
import { DeviceFileTree } from './DeviceFileTree';

const EXPLORER_PANEL_ID = 'device-files-explorer-panel';
const SEARCH_PANEL_ID = 'device-files-search-panel';
const EXPLORER_BUTTON_ID = 'device-files-explorer-mode-button';
const SEARCH_BUTTON_ID = 'device-files-search-mode-button';

enum DeviceFilesSidebarMode {
  Explorer = 'explorer',
  Search = 'search',
}

function formatSearchScopeLabel(entry: DeviceFileTreeEntry): string {
  if (entry.absolutePath) return entry.absolutePath;
  if (entry.pathComponents.length > 0) return entry.pathComponents.join(' / ');
  return entry.name;
}

export function DeviceFilesSidebar({
  files,
  tagsState,
  tagFilter,
  onTagFilterChange,
}: {
  files: DeviceFilesState;
  tagsState: DeviceAnalyticsTagsState;
  tagFilter: DeviceAnalyticsTagFilter;
  onTagFilterChange: (filter: DeviceAnalyticsTagFilter) => void;
}) {
  const [mode, setMode] = useState(DeviceFilesSidebarMode.Explorer);
  const searchRoot =
    files.searchScope === null
      ? null
      : (files.roots.find((root) => root.entryId === files.searchScope?.rootEntryId) ?? null);
  const nestedSearchScope =
    files.searchScope !== null && files.searchScope.entryId !== files.searchScope.rootEntryId;
  const showModeBody = !files.rootsLoading && files.roots.length > 0;
  const showStatus =
    files.rootsLoading ||
    files.rootsError !== null ||
    files.scopeNotice !== null ||
    (files.roots.length === 0 && !files.rootsLoading);

  const openSearchDirectory = (entryId: string) => {
    if (files.searchScope?.entryId === entryId) {
      files.clearSearchResults();
      return;
    }

    const entry = files.searchEntries.find((item) => item.entryId === entryId);
    if (entry?.kind !== 'directory' || files.searchScope === null) return;
    files.selectSearchScope({
      entryId: entry.entryId,
      rootEntryId: files.searchScope.rootEntryId,
      label: formatSearchScopeLabel(entry),
    });
  };

  const resetSearchScopeToRoot = () => {
    if (searchRoot === null) return;
    files.selectSearchScope({
      entryId: searchRoot.entryId,
      rootEntryId: searchRoot.entryId,
      label: searchRoot.name,
    });
  };

  return (
    <aside
      aria-labelledby="device-files-sidebar-title"
      data-testid="device-files-sidebar"
      aria-busy={files.rootsLoading || files.rootsRefreshing}
      className="flex max-h-[50vh] min-h-0 min-w-0 flex-col overflow-hidden rounded-echo-md border border-echo-border bg-echo-surface echo-lg:h-full echo-lg:max-h-none"
    >
      <header className="flex shrink-0 items-center justify-between gap-echo-sm border-b border-echo-border px-echo-md py-echo-sm">
        <h2
          id="device-files-sidebar-title"
          className="m-0 min-w-0 truncate text-echo-lg font-semibold text-echo-text"
        >
          Файли
        </h2>
        <div className="flex shrink-0 items-center gap-echo-xs">
          <div
            role="group"
            aria-label="Режим файлової панелі"
            className="flex items-center gap-echo-xs"
          >
            <Tooltip title="Показати файлове дерево">
              <PowerIconButton
                id={EXPLORER_BUTTON_ID}
                size="small"
                aria-label="Показати файлове дерево"
                aria-pressed={mode === DeviceFilesSidebarMode.Explorer}
                aria-controls={EXPLORER_PANEL_ID}
                onClick={() => setMode(DeviceFilesSidebarMode.Explorer)}
                sx={{
                  bgcolor: mode === DeviceFilesSidebarMode.Explorer ? 'action.selected' : undefined,
                }}
              >
                <FolderOutlinedIcon fontSize="small" />
              </PowerIconButton>
            </Tooltip>
            <Tooltip title="Показати пошук файлів">
              <PowerIconButton
                id={SEARCH_BUTTON_ID}
                size="small"
                aria-label="Показати пошук файлів"
                aria-pressed={mode === DeviceFilesSidebarMode.Search}
                aria-controls={SEARCH_PANEL_ID}
                onClick={() => setMode(DeviceFilesSidebarMode.Search)}
                sx={{
                  bgcolor: mode === DeviceFilesSidebarMode.Search ? 'action.selected' : undefined,
                }}
              >
                <SearchIcon fontSize="small" />
              </PowerIconButton>
            </Tooltip>
          </div>
          <Tooltip title="Оновити файлові дані">
            <span>
              <PowerIconButton
                size="small"
                aria-label="Оновити файлові дані"
                onClick={() => void files.refreshVisible()}
                disabled={files.rootsLoading || files.rootsRefreshing || files.tree.refreshing}
              >
                <RefreshIcon fontSize="small" />
              </PowerIconButton>
            </span>
          </Tooltip>
        </div>
      </header>

      {showStatus ? (
        <div className="shrink-0 space-y-echo-sm border-b border-echo-border p-echo-sm">
          {files.rootsLoading ? (
            <div
              className="flex min-h-20 items-center justify-center gap-echo-sm text-echo-sm text-echo-text-muted"
              role="status"
            >
              <CircularProgress size={24} aria-label="Завантаження файлових даних" />
              <span>Завантаження файлових даних…</span>
            </div>
          ) : null}
          {files.rootsError ? (
            <PowerAlert
              severity="error"
              autoHideDuration={null}
              action={
                <PowerButton size="small" onClick={() => void files.reloadRoots()}>
                  Повторити
                </PowerButton>
              }
            >
              {files.rootsError.message}
            </PowerAlert>
          ) : null}
          {!files.rootsLoading && files.roots.length === 0 && files.rootsError === null ? (
            <PowerAlert severity="info" autoHideDuration={null}>
              Для пристрою ще немає синхронізованих файлів.
            </PowerAlert>
          ) : null}
          {files.scopeNotice ? (
            <PowerAlert severity="warning" autoHideDuration={null}>
              {files.scopeNotice}
            </PowerAlert>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-echo-sm">
        {showModeBody ? (
          <>
            <div
              id={EXPLORER_PANEL_ID}
              role="region"
              aria-labelledby={EXPLORER_BUTTON_ID}
              hidden={mode !== DeviceFilesSidebarMode.Explorer}
              className="min-w-0"
            >
              <DeviceFileTree files={files} />
            </div>
            <div
              id={SEARCH_PANEL_ID}
              role="region"
              aria-labelledby={SEARCH_BUTTON_ID}
              hidden={mode !== DeviceFilesSidebarMode.Search}
              className="min-w-0 space-y-echo-md"
            >
              <DeviceFileSearchControls
                draft={files.searchDraft}
                validationErrors={files.searchValidationErrors}
                scopeSelected={files.searchScope !== null}
                scopeLabel={files.searchScope?.label ?? null}
                rootScopeLabel={nestedSearchScope ? (searchRoot?.name ?? null) : null}
                searching={files.searchLoading || files.searchRefreshing}
                searchActive={files.searchActive}
                tagsState={tagsState}
                tagFilter={tagFilter}
                onChange={files.setSearchDraft}
                onSearch={files.submitSearch}
                onHideResults={files.clearSearchResults}
                onResetScopeToRoot={resetSearchScopeToRoot}
                onTagFilterChange={onTagFilterChange}
              />
              {files.searchActive ? (
                <DeviceFileSearchResults
                  entries={files.searchEntries}
                  loading={files.searchLoading}
                  refreshing={files.searchRefreshing}
                  loadingMore={files.searchLoadingMore}
                  nextCursor={files.searchNextCursor}
                  error={files.searchError}
                  loadMoreError={files.searchLoadMoreError}
                  onOpenDirectory={openSearchDirectory}
                  onRetry={() => void files.retrySearch()}
                  onLoadMore={() => void files.loadMoreSearch()}
                />
              ) : (
                <div className="rounded-echo-md border border-echo-border p-echo-md text-center text-echo-sm text-echo-text-muted">
                  Налаштуйте область і фільтри та виконайте пошук.
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </aside>
  );
}
