import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import SyncOutlinedIcon from '@mui/icons-material/SyncOutlined';
import {
  Box,
  Breadcrumbs,
  CircularProgress,
  Divider,
  Link,
  Paper,
  Stack,
  Typography,
} from '@mui/material';

import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { DeviceAnalyticsTagBadges } from './DeviceAnalyticsTagBadges';
import { formatDeviceDateTime } from '../../devices/helpers';
import type { DeviceFileLoadError } from '../types';

type Props = {
  breadcrumbs: Array<{ entryId: string; name: string }>;
  entries: DeviceFileTreeEntry[];
  mode: 'browse' | 'search';
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  error: DeviceFileLoadError | null;
  loadMoreError: DeviceFileLoadError | null;
  canSync: boolean;
  onOpenDirectory: (entryId: string) => void;
  onSyncFile: (entry: DeviceFileTreeEntry) => void;
  onRetry: () => void;
  onLoadMore: () => void;
};

function FileEntryMetadata({ entry }: { entry: DeviceFileTreeEntry }) {
  return (
    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <Typography variant="caption" color="text.secondary">
        MIME: {entry.mimeType ?? '—'}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Розширення: {entry.extension ?? '—'}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Змінено у джерелі: {formatDeviceDateTime(entry.fileMetadataModifiedAt)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        Оновлено в ЕХО: {formatDeviceDateTime(entry.updatedAt)}
      </Typography>
    </Stack>
  );
}

function FileEntryRow({
  entry,
  canSync,
  onOpenDirectory,
  onSyncFile,
}: {
  entry: DeviceFileTreeEntry;
  canSync: boolean;
  onOpenDirectory: (entryId: string) => void;
  onSyncFile: (entry: DeviceFileTreeEntry) => void;
}) {
  const directory = entry.kind === 'directory';
  return (
    <Box component="li" data-entry-id={entry.entryId} sx={{ listStyle: 'none', py: 1.25, px: 1.5 }}>
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Box sx={{ color: directory ? 'primary.main' : 'text.secondary', pt: 0.25 }}>
          {directory ? <FolderOpenOutlinedIcon /> : <InsertDriveFileOutlinedIcon />}
        </Box>
        <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
          {directory ? (
            <Link
              component="button"
              type="button"
              underline="hover"
              fontWeight={600}
              sx={{ alignSelf: 'flex-start', textAlign: 'left', overflowWrap: 'anywhere' }}
              onClick={() => onOpenDirectory(entry.entryId)}
            >
              {entry.name}
            </Link>
          ) : (
            <Typography variant="body2" fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
              {entry.name}
            </Typography>
          )}
          {!directory ? <DeviceAnalyticsTagBadges tags={entry.tags} /> : null}
          <Typography
            component="code"
            variant="caption"
            sx={{ color: 'text.secondary', overflowWrap: 'anywhere', wordBreak: 'break-word' }}
          >
            {entry.absolutePath}
          </Typography>
          {entry.pathComponents.length > 0 ? (
            <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
              Компоненти: {entry.pathComponents.join(' / ')}
            </Typography>
          ) : null}
          <FileEntryMetadata entry={entry} />
        </Stack>
        {!directory && canSync ? (
          <PowerIconButton
            size="small"
            aria-label={`Синхронізувати метадані ${entry.name}`}
            onClick={() => onSyncFile(entry)}
          >
            <SyncOutlinedIcon fontSize="small" />
          </PowerIconButton>
        ) : null}
      </Stack>
    </Box>
  );
}

export function DeviceFileEntries({
  breadcrumbs,
  entries,
  mode,
  loading,
  refreshing,
  loadingMore,
  nextCursor,
  error,
  loadMoreError,
  canSync,
  onOpenDirectory,
  onSyncFile,
  onRetry,
  onLoadMore,
}: Props) {
  return (
    <Stack spacing={1.5} sx={{ minHeight: 0 }}>
      <Breadcrumbs aria-label="Шлях файлової системи" maxItems={6}>
        {breadcrumbs.map((breadcrumb) => (
          <Link
            key={breadcrumb.entryId}
            component="button"
            type="button"
            underline="hover"
            onClick={() => onOpenDirectory(breadcrumb.entryId)}
          >
            {breadcrumb.name}
          </Link>
        ))}
      </Breadcrumbs>

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
        <Box sx={{ minHeight: 160, display: 'grid', placeItems: 'center' }}>
          <CircularProgress size={28} aria-label="Завантаження файлів" />
        </Box>
      ) : entries.length === 0 && error === null ? (
        <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            {mode === 'search' ? 'За заданими фільтрами нічого не знайдено.' : 'Каталог порожній.'}
          </Typography>
        </Paper>
      ) : (
        <Paper
          variant="outlined"
          sx={{ position: 'relative', minHeight: 0, overflow: 'auto' }}
          aria-busy={refreshing}
        >
          <Box component="ul" sx={{ m: 0, p: 0 }}>
            {entries.map((entry, index) => (
              <Box key={entry.entryId}>
                {index > 0 ? <Divider /> : null}
                <FileEntryRow
                  entry={entry}
                  canSync={canSync}
                  onOpenDirectory={onOpenDirectory}
                  onSyncFile={onSyncFile}
                />
              </Box>
            ))}
          </Box>
          {refreshing ? (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                bgcolor: 'action.disabledBackground',
                opacity: 0.35,
                pointerEvents: 'none',
              }}
            />
          ) : null}
        </Paper>
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
        <PowerButton
          variant="outlined"
          onClick={onLoadMore}
          disabled={loadingMore}
          sx={{ alignSelf: 'center' }}
        >
          {loadingMore ? 'Завантаження…' : 'Завантажити ще'}
        </PowerButton>
      ) : null}
    </Stack>
  );
}
