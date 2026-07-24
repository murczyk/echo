import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import dayjs from 'dayjs';

import type { PathSyntax } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerButton } from '../../../components/PowerButton';
import { PowerDateTimePicker } from '../../../components/PowerDateTimePicker';
import { PowerIconButton } from '../../../components/PowerIconButton';
import { formatFileSyncError, formatSyncOperation } from '../helpers';
import type { DeviceFileSyncField, DeviceFileSyncRow } from '../types';

type Props = {
  open: boolean;
  pathSyntax: PathSyntax;
  rows: DeviceFileSyncRow[];
  submitting: boolean;
  batchError: string | null;
  transportUncertain: boolean;
  canSubmit: boolean;
  onClose: () => void;
  onPathSyntaxChange: (pathSyntax: PathSyntax) => void;
  onAddRow: () => void;
  onRemoveRow: (localId: string) => void;
  onChangeRowField: (localId: string, field: DeviceFileSyncField, value: string | null) => void;
  onSubmit: () => void;
};

function SyncRowFields({
  row,
  disabled,
  canRemove,
  onRemove,
  onChange,
}: {
  row: DeviceFileSyncRow;
  disabled: boolean;
  canRemove: boolean;
  onRemove: () => void;
  onChange: (field: DeviceFileSyncField, value: string | null) => void;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <Typography variant="subtitle2">
            {row.fileId === null ? 'Новий файл' : `Файл ${row.fileId}`}
          </Typography>
          {canRemove ? (
            <PowerIconButton
              size="small"
              aria-label="Видалити рядок батча"
              onClick={onRemove}
              disabled={disabled}
            >
              <DeleteOutlineIcon fontSize="small" />
            </PowerIconButton>
          ) : null}
        </Stack>

        {row.result?.kind === 'rejected' ? (
          <PowerAlert severity="error" autoHideDuration={null}>
            {formatFileSyncError(row.result.error)}
          </PowerAlert>
        ) : null}

        <TextField
          label="Абсолютний шлях"
          value={row.absolutePath}
          onChange={(event) => onChange('absolutePath', event.target.value)}
          error={Boolean(row.fieldErrors.absolutePath)}
          helperText={row.fieldErrors.absolutePath ?? 'Шлях передається без нормалізації'}
          disabled={disabled}
          required
          fullWidth
          size="small"
        />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <TextField
            label="MIME-тип"
            value={row.mimeType}
            onChange={(event) => onChange('mimeType', event.target.value)}
            error={Boolean(row.fieldErrors.mimeType)}
            helperText={row.fieldErrors.mimeType}
            disabled={disabled}
            fullWidth
            size="small"
          />
          <TextField
            label="Розширення"
            value={row.extension}
            onChange={(event) => onChange('extension', event.target.value)}
            error={Boolean(row.fieldErrors.extension)}
            helperText={row.fieldErrors.extension}
            disabled={disabled}
            fullWidth
            size="small"
          />
        </Stack>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
          <PowerDateTimePicker
            label="Створено у джерелі"
            value={row.fileMetadataCreatedAt === null ? null : dayjs(row.fileMetadataCreatedAt)}
            allowEmpty
            disabled={disabled}
            onChange={(value) =>
              onChange('fileMetadataCreatedAt', value?.isValid() ? value.toISOString() : null)
            }
            slotProps={{
              textField: {
                size: 'small',
                fullWidth: true,
                error: Boolean(row.fieldErrors.fileMetadataCreatedAt),
                helperText: row.fieldErrors.fileMetadataCreatedAt,
              },
            }}
          />
          <PowerDateTimePicker
            label="Змінено у джерелі"
            value={row.fileMetadataModifiedAt === null ? null : dayjs(row.fileMetadataModifiedAt)}
            allowEmpty
            disabled={disabled}
            onChange={(value) =>
              onChange('fileMetadataModifiedAt', value?.isValid() ? value.toISOString() : null)
            }
            slotProps={{
              textField: {
                size: 'small',
                fullWidth: true,
                error: Boolean(row.fieldErrors.fileMetadataModifiedAt),
                helperText: row.fieldErrors.fileMetadataModifiedAt,
              },
            }}
          />
        </Stack>
      </Stack>
    </Paper>
  );
}

function AcceptedSyncRow({ row }: { row: DeviceFileSyncRow }) {
  if (row.result?.kind !== 'accepted') return null;
  return (
    <PowerAlert severity="success" autoHideDuration={null}>
      <Stack spacing={0.25}>
        <Typography variant="body2" fontWeight={600}>
          {formatSyncOperation(row.result.operation)}: {row.result.file.absolutePath}
        </Typography>
        <Typography variant="caption">
          Root ID: {row.result.root.entryId}; File ID: {row.result.file.fileId}
        </Typography>
      </Stack>
    </PowerAlert>
  );
}

export function DeviceFileSyncDialog({
  open,
  pathSyntax,
  rows,
  submitting,
  batchError,
  transportUncertain,
  canSubmit,
  onClose,
  onPathSyntaxChange,
  onAddRow,
  onRemoveRow,
  onChangeRowField,
  onSubmit,
}: Props) {
  const acceptedCount = rows.filter((row) => row.result?.kind === 'accepted').length;
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" aria-labelledby="file-sync-title">
      <DialogTitle id="file-sync-title">Синхронізація файлових метаданих</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <TextField
            select
            label="Синтаксис шляхів"
            value={pathSyntax}
            onChange={(event) => onPathSyntaxChange(event.target.value as PathSyntax)}
            disabled={submitting}
            size="small"
            sx={{ maxWidth: 260 }}
          >
            <MenuItem value="posix">POSIX</MenuItem>
            <MenuItem value="windows">Windows</MenuItem>
          </TextField>

          {batchError ? (
            <PowerAlert severity="error" autoHideDuration={null}>
              {batchError}
            </PowerAlert>
          ) : null}
          {transportUncertain ? (
            <PowerAlert severity="warning" autoHideDuration={null}>
              Автоматичний повтор вимкнено, щоб не дублювати невизначений запис.
            </PowerAlert>
          ) : null}

          {rows.map((row) =>
            row.result?.kind === 'accepted' ? (
              <AcceptedSyncRow key={row.localId} row={row} />
            ) : (
              <SyncRowFields
                key={row.localId}
                row={row}
                disabled={submitting}
                canRemove={rows.length > 1}
                onRemove={() => onRemoveRow(row.localId)}
                onChange={(field, value) => onChangeRowField(row.localId, field, value)}
              />
            ),
          )}

          <PowerButton
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={onAddRow}
            disabled={submitting}
            sx={{ alignSelf: 'flex-start' }}
          >
            Додати файл
          </PowerButton>
        </Stack>
      </DialogContent>
      <DialogActions>
        <PowerButton onClick={onClose} disabled={submitting}>
          Закрити
        </PowerButton>
        <PowerButton variant="contained" onClick={onSubmit} disabled={submitting || !canSubmit}>
          {submitting
            ? 'Надсилання…'
            : acceptedCount > 0
              ? 'Повторити відхилені'
              : 'Синхронізувати'}
        </PowerButton>
      </DialogActions>
    </Dialog>
  );
}
