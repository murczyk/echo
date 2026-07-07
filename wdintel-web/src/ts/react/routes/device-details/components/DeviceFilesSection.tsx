import DeleteIcon from '@mui/icons-material/Delete';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestoreIcon from '@mui/icons-material/Restore';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  CircularProgress,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';

import type { DeviceFileEntry } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
import { TableEmptyState } from '../../../components/TableEmptyState';
import { formatDeviceDateTime } from '../../devices/helpers';
import type { DeviceFilesDeletedFilterValue } from '../helpers';
import type { DeviceDetailsUiMessage } from '../use-device-details-page';

type Props = {
  files: DeviceFileEntry[];
  deletedFilter: DeviceFilesDeletedFilterValue;
  total: number;
  hasMore: boolean;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  status: DeviceDetailsUiMessage;
  mutatingFileId: string | null;
  canEdit: boolean;
  parentDeleted: boolean;
  hasFilters: boolean;
  onDeletedFilterChange: (value: DeviceFilesDeletedFilterValue) => void;
  onCreate: () => void;
  onReload: () => Promise<void>;
  onLoadMore: () => Promise<void>;
  onDelete: (file: DeviceFileEntry) => void;
  onRestore: (file: DeviceFileEntry) => void;
};

function deletedFilterLabel(value: DeviceFilesDeletedFilterValue): string {
  switch (value) {
    case 'deleted':
      return 'Видалені';
    case 'all':
      return 'Всі';
    case 'active':
      return 'Активні';
  }
}

function FileLifecycleCell({ file }: { file: DeviceFileEntry }) {
  return file.deleted ? (
    <Typography variant="body2" color="warning.main">
      Видалено
    </Typography>
  ) : (
    <Typography variant="body2" color="success.main">
      Активний
    </Typography>
  );
}

function FileRowActions({
  file,
  canEdit,
  parentDeleted,
  disabled,
  onDelete,
  onRestore,
}: {
  file: DeviceFileEntry;
  canEdit: boolean;
  parentDeleted: boolean;
  disabled: boolean;
  onDelete: (file: DeviceFileEntry) => void;
  onRestore: (file: DeviceFileEntry) => void;
}) {
  if (!canEdit) return null;

  const title = parentDeleted
    ? 'Відновіть пристрій перед зміною життєвого циклу файлів'
    : file.deleted
      ? 'Відновити файл'
      : 'Видалити файл';

  return (
    <Tooltip title={title}>
      <span>
        <IconButton
          size="small"
          disabled={disabled || parentDeleted}
          color={file.deleted ? 'primary' : 'error'}
          aria-label={file.deleted ? 'Відновити файл' : 'Видалити файл'}
          onClick={() => (file.deleted ? onRestore(file) : onDelete(file))}
        >
          {file.deleted ? <RestoreIcon fontSize="small" /> : <DeleteIcon fontSize="small" />}
        </IconButton>
      </span>
    </Tooltip>
  );
}

export function DeviceFilesSection({
  files,
  deletedFilter,
  total,
  hasMore,
  loading,
  refreshing,
  loadingMore,
  status,
  mutatingFileId,
  canEdit,
  parentDeleted,
  hasFilters,
  onDeletedFilterChange,
  onCreate,
  onReload,
  onLoadMore,
  onDelete,
  onRestore,
}: Props) {
  const showLifecycle = deletedFilter !== 'active';
  const emptyMessage = hasFilters ? 'Файли не знайдено' : 'Файли ще не додані';

  return (
    <Card variant="outlined" sx={{ position: 'relative', overflow: 'hidden' }}>
      <CardHeader
        title="Файли"
        subheader={`Метадані файлів${total > 0 ? ` · знайдено: ${total}` : ''}`}
        action={
          <Stack direction="row" spacing={1} alignItems="center">
            <ToggleButtonGroup
              exclusive
              size="small"
              value={deletedFilter}
              disabled={loading || refreshing || loadingMore}
              onChange={(_, value: DeviceFilesDeletedFilterValue | null) => {
                if (value !== null) onDeletedFilterChange(value);
              }}
              aria-label="Фільтр стану файлів"
            >
              <ToggleButton value="active">Активні</ToggleButton>
              <ToggleButton value="deleted">Видалені</ToggleButton>
              <ToggleButton value="all">Всі</ToggleButton>
            </ToggleButtonGroup>
            {canEdit ? (
              <Tooltip
                title={
                  parentDeleted ? 'Відновіть пристрій перед додаванням файлів' : 'Додати файли'
                }
              >
                <span>
                  <Button size="small" onClick={onCreate} disabled={parentDeleted}>
                    Додати файли
                  </Button>
                </span>
              </Tooltip>
            ) : null}
            <Tooltip title="Оновити файли">
              <span>
                <IconButton
                  size="small"
                  aria-label="Оновити файли"
                  onClick={() => void onReload()}
                  disabled={loading || refreshing || loadingMore}
                >
                  {refreshing ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        }
      />
      <CardContent>
        <Stack spacing={2}>
          {parentDeleted && canEdit ? (
            <Alert severity="warning">
              Відновіть пристрій перед додаванням, видаленням або відновленням файлів.
            </Alert>
          ) : null}
          {status ? <PowerAlert severity={status.kind}>{status.text}</PowerAlert> : null}

          {loading && files.length === 0 ? (
            <Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}>
              <CircularProgress size={28} />
            </Box>
          ) : files.length === 0 ? (
            <TableEmptyState message={emptyMessage} />
          ) : (
            <TableContainer sx={{ maxHeight: 520 }}>
              <Table stickyHeader size="small" aria-label="Метадані файлів пристрою">
                <TableHead>
                  <TableRow>
                    <TableCell>Назва</TableCell>
                    <TableCell>Абсолютний шлях</TableCell>
                    <TableCell>Оригінал створено</TableCell>
                    <TableCell>Оригінал змінено</TableCell>
                    <TableCell>Додано в Echo</TableCell>
                    <TableCell>Оновлено в Echo</TableCell>
                    {showLifecycle ? <TableCell>Стан</TableCell> : null}
                    {canEdit ? <TableCell align="right">Дії</TableCell> : null}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {files.map((file) => (
                    <TableRow key={file.fileId} hover>
                      <TableCell sx={{ minWidth: 180, maxWidth: 260, overflowWrap: 'anywhere' }}>
                        {file.originalName?.trim() || '—'}
                      </TableCell>
                      <TableCell sx={{ minWidth: 220, maxWidth: 420, overflowWrap: 'anywhere' }}>
                        {file.originalAbsolutePath?.trim() || '—'}
                      </TableCell>
                      <TableCell>{formatDeviceDateTime(file.originalCreatedAtMs)}</TableCell>
                      <TableCell>{formatDeviceDateTime(file.originalModifiedAtMs)}</TableCell>
                      <TableCell>{formatDeviceDateTime(file.createdAtMs)}</TableCell>
                      <TableCell>{formatDeviceDateTime(file.updatedAtMs)}</TableCell>
                      {showLifecycle ? (
                        <TableCell>
                          <FileLifecycleCell file={file} />
                        </TableCell>
                      ) : null}
                      {canEdit ? (
                        <TableCell align="right">
                          <FileRowActions
                            file={file}
                            canEdit={canEdit}
                            parentDeleted={parentDeleted}
                            disabled={mutatingFileId === file.fileId || mutatingFileId !== null}
                            onDelete={onDelete}
                            onRestore={onRestore}
                          />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          {files.length > 0 ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="center">
              <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                Показано {files.length} з {total}. Фільтр: {deletedFilterLabel(deletedFilter)}.
              </Typography>
              {hasMore ? (
                <Button onClick={() => void onLoadMore()} disabled={loadingMore || refreshing}>
                  {loadingMore ? 'Завантаження...' : 'Завантажити ще'}
                </Button>
              ) : null}
            </Stack>
          ) : null}
        </Stack>
      </CardContent>
      <SectionLoadingOverlay
        open={refreshing && files.length > 0}
        ariaLabel="Оновлення метаданих файлів"
        showSpinner={false}
      />
    </Card>
  );
}
