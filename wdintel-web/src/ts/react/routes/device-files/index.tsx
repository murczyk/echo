import RefreshIcon from '@mui/icons-material/Refresh';
import SyncOutlinedIcon from '@mui/icons-material/SyncOutlined';
import {
  Box,
  CircularProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerIconButton } from '../../components/PowerIconButton';
import { DeviceFileEntries } from './components/DeviceFileEntries';
import { DeviceFileSearchControls } from './components/DeviceFileSearchControls';
import { DeviceFileSyncDialog } from './components/DeviceFileSyncDialog';
import { useDeviceFiles } from './use-device-files';

export function DeviceFilesPanel({
  deviceId,
  canRead,
  canSync,
}: {
  deviceId: string;
  canRead: boolean;
  canSync: boolean;
}) {
  const files = useDeviceFiles({ deviceId, enabled: canRead, canSync });
  if (!canRead) return null;

  const entries = files.mode === 'search' ? files.searchEntries : files.browseEntries;
  const nextCursor = files.mode === 'search' ? files.searchNextCursor : files.browseNextCursor;
  const loading = files.mode === 'search' ? files.searchLoading : files.browseLoading;
  const refreshing = files.mode === 'search' ? files.searchRefreshing : files.browseRefreshing;
  const loadingMore = files.mode === 'search' ? files.searchLoadingMore : files.browseLoadingMore;
  const error = files.mode === 'search' ? files.searchError : files.browseError;
  const loadMoreError =
    files.mode === 'search' ? files.searchLoadMoreError : files.browseLoadMoreError;

  return (
    <Paper
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
              Поточні технічні метадані файлової системи
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.5}>
            <PowerIconButton
              aria-label="Оновити файлові дані"
              onClick={() => void files.refreshVisible()}
              disabled={files.rootsLoading || files.rootsRefreshing}
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
            <CircularProgress size={28} aria-label="Завантаження коренів" />
          </Box>
        ) : files.roots.length === 0 && files.rootsError === null ? (
          <PowerAlert severity="info" autoHideDuration={null}>
            Для пристрою ще немає файлових коренів.
          </PowerAlert>
        ) : (
          <TextField
            select
            label="Корінь файлової системи"
            value={files.selectedRootId ?? ''}
            onChange={(event) => {
              const root = files.roots.find((item) => item.entryId === event.target.value);
              if (root) files.selectRoot(root);
            }}
            size="small"
            fullWidth
            disabled={files.rootsRefreshing}
            helperText="Корінь потрібно вибрати явно"
          >
            <MenuItem value="" disabled>
              Виберіть корінь
            </MenuItem>
            {files.roots.map((root) => (
              <MenuItem key={root.entryId} value={root.entryId}>
                {root.name} · {root.pathSyntax.toUpperCase()} · {root.entryId}
              </MenuItem>
            ))}
          </TextField>
        )}

        {files.selectedRootId !== null ? (
          <>
            <DeviceFileSearchControls
              draft={files.searchDraft}
              validationErrors={files.searchValidationErrors}
              scopeSelected={files.browseParentId !== null}
              searching={files.searchLoading || files.searchRefreshing}
              searchMode={files.mode === 'search'}
              onChange={files.setSearchDraft}
              onSearch={files.submitSearch}
              onBackToBrowse={files.backToBrowse}
            />
            <DeviceFileEntries
              breadcrumbs={files.breadcrumbs}
              entries={entries}
              mode={files.mode}
              loading={loading}
              refreshing={refreshing}
              loadingMore={loadingMore}
              nextCursor={nextCursor}
              error={error}
              loadMoreError={loadMoreError}
              canSync={canSync}
              onOpenDirectory={files.openDirectory}
              onSyncFile={files.sync.openSyncForEntry}
              onRetry={() =>
                void (files.mode === 'search' ? files.retrySearch() : files.retryBrowse())
              }
              onLoadMore={() =>
                void (files.mode === 'search' ? files.loadMoreSearch() : files.loadMoreBrowse())
              }
            />
          </>
        ) : files.roots.length > 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
            Виберіть корінь, щоб переглянути його безпосередніх нащадків.
          </Typography>
        ) : null}
      </Stack>

      <DeviceFileSyncDialog
        open={files.sync.open}
        pathSyntax={files.sync.pathSyntax}
        rows={files.sync.rows}
        submitting={files.sync.submitting}
        batchError={files.sync.batchError}
        transportUncertain={files.sync.transportUncertain}
        canSubmit={files.sync.canSubmit}
        onClose={files.sync.closeSync}
        onPathSyntaxChange={files.sync.setPathSyntax}
        onAddRow={files.sync.addRow}
        onRemoveRow={files.sync.removeRow}
        onChangeRowField={files.sync.changeRowField}
        onSubmit={() => void files.sync.submit()}
      />
    </Paper>
  );
}
