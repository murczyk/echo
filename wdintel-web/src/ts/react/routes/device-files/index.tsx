import RefreshIcon from '@mui/icons-material/Refresh';
import SyncOutlinedIcon from '@mui/icons-material/SyncOutlined';
import { Box, CircularProgress, Paper, Stack, Typography } from '@mui/material';

import type { DeviceFileTreeEntry } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerIconButton } from '../../components/PowerIconButton';
import { DeviceFileEntries } from './components/DeviceFileEntries';
import { DeviceFileSearchControls } from './components/DeviceFileSearchControls';
import { DeviceFileSyncDialog } from './components/DeviceFileSyncDialog';
import type { DeviceAnalyticsTagFilter } from './types';
import type { DeviceAnalyticsTagsState } from './use-device-analytics-tags';
import type { DeviceFilesState } from './use-device-files';

function formatSearchScopeLabel(entry: DeviceFileTreeEntry): string {
  if (entry.absolutePath) return entry.absolutePath;
  if (entry.pathComponents.length > 0) return entry.pathComponents.join(' / ');
  return entry.name;
}

export function DeviceFilesPanel({
  files,
  canSync,
  tagsState,
  tagFilter,
  onTagFilterChange,
}: {
  files: DeviceFilesState;
  canSync: boolean;
  tagsState: DeviceAnalyticsTagsState;
  tagFilter: DeviceAnalyticsTagFilter;
  onTagFilterChange: (filter: DeviceAnalyticsTagFilter) => void;
}) {
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

  return (
    <Box
      component="section"
      aria-labelledby="device-files-title"
      sx={{ p: 2, minWidth: 0, minHeight: 0, height: '100%', overflow: 'auto' }}
    >
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Box sx={{ minWidth: 0 }}>
            <Typography id="device-files-title" variant="h6">
              Файли
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Пошук у синхронізованих файлових даних
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.5}>
            <PowerIconButton
              aria-label="Оновити файлові дані"
              onClick={() => void files.refreshVisible()}
              disabled={files.rootsLoading || files.rootsRefreshing || files.tree.refreshing}
            >
              <RefreshIcon fontSize="small" />
            </PowerIconButton>
            {canSync ? (
              <PowerButton
                size="small"
                variant="contained"
                startIcon={<SyncOutlinedIcon />}
                onClick={() => files.sync.openSync()}
              >
                Синхронізувати
              </PowerButton>
            ) : null}
          </Stack>
        </Stack>

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
        {files.scopeNotice ? (
          <PowerAlert severity="warning" autoHideDuration={null}>
            {files.scopeNotice}
          </PowerAlert>
        ) : null}

        {files.rootsLoading ? (
          <Box sx={{ minHeight: 120, display: 'grid', placeItems: 'center' }}>
            <CircularProgress size={28} aria-label="Завантаження файлових даних" />
          </Box>
        ) : files.roots.length === 0 && files.rootsError === null ? (
          <PowerAlert severity="info" autoHideDuration={null}>
            Для пристрою ще немає синхронізованих файлів.
          </PowerAlert>
        ) : (
          <>
            <DeviceFileSearchControls
              draft={files.searchDraft}
              validationErrors={files.searchValidationErrors}
              scopeSelected={files.searchScope !== null}
              scopeLabel={files.searchScope?.label ?? null}
              searching={files.searchLoading || files.searchRefreshing}
              searchMode={files.searchActive}
              tagsState={tagsState}
              tagFilter={tagFilter}
              onChange={files.setSearchDraft}
              onSearch={files.submitSearch}
              onBackToBrowse={files.clearSearchResults}
              onTagFilterChange={onTagFilterChange}
            />
            {files.searchActive ? (
              <DeviceFileEntries
                breadcrumbs={
                  files.searchScope
                    ? [{ entryId: files.searchScope.entryId, name: files.searchScope.label }]
                    : []
                }
                entries={files.searchEntries}
                mode="search"
                loading={files.searchLoading}
                refreshing={files.searchRefreshing}
                loadingMore={files.searchLoadingMore}
                nextCursor={files.searchNextCursor}
                error={files.searchError}
                loadMoreError={files.searchLoadMoreError}
                canSync={canSync}
                onOpenDirectory={openSearchDirectory}
                onSyncFile={files.sync.openSyncForEntry}
                onRetry={() => void files.retrySearch()}
                onLoadMore={() => void files.loadMoreSearch()}
              />
            ) : (
              <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
                <Typography variant="body2" color="text.secondary">
                  Виберіть область у файловому дереві, налаштуйте фільтри та виконайте пошук.
                </Typography>
              </Paper>
            )}
          </>
        )}
      </Stack>

      <DeviceFileSyncDialog
        open={files.sync.open}
        rows={files.sync.rows}
        submitting={files.sync.submitting}
        batchError={files.sync.batchError}
        transportUncertain={files.sync.transportUncertain}
        canSubmit={files.sync.canSubmit}
        onClose={files.sync.closeSync}
        onAddRow={files.sync.addRow}
        onRemoveRow={files.sync.removeRow}
        onChangeRowField={files.sync.changeRowField}
        onSubmit={() => void files.sync.submit()}
      />
    </Box>
  );
}
