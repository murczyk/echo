import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  Alert,
  Box,
  Button,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';

import {
  createDeviceFileDraft,
  DEVICE_FILE_CREATE_BATCH_MAX_COUNT,
  type DeviceFileDraft,
  type DeviceFileDraftError,
} from '../device-form';

type Props = {
  rows: DeviceFileDraft[];
  errors: Record<string, DeviceFileDraftError>;
  disabled: boolean;
  title?: string;
  emptyText?: string;
  onChange: (rows: DeviceFileDraft[]) => void;
};

function replaceRow(
  rows: DeviceFileDraft[],
  rowId: string,
  patch: Partial<DeviceFileDraft>,
): DeviceFileDraft[] {
  return rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row));
}

export function DeviceFileRowsEditor({
  rows,
  errors,
  disabled,
  title = 'Нові файли',
  emptyText = 'Файли не додані.',
  onChange,
}: Props) {
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Box>
          <Typography variant="subtitle2">{title}</Typography>
          <Typography variant="caption" color="text.secondary">
            Лише метадані. Максимум {DEVICE_FILE_CREATE_BATCH_MAX_COUNT} файлів за запит.
          </Typography>
        </Box>
        <Button
          size="small"
          startIcon={<AddIcon />}
          onClick={() => onChange([...rows, createDeviceFileDraft()])}
          disabled={disabled || rows.length >= DEVICE_FILE_CREATE_BATCH_MAX_COUNT}
        >
          Додати файл
        </Button>
      </Stack>

      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {emptyText}
        </Typography>
      ) : (
        <Stack spacing={1.25}>
          {rows.map((row, index) => {
            const rowErrors = errors[row.id] ?? {};
            return (
              <Box
                key={row.id}
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 2,
                  p: 1.5,
                }}
              >
                <Stack spacing={1.25}>
                  <Stack
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                    spacing={1}
                  >
                    <Typography variant="subtitle2">Файл {index + 1}</Typography>
                    <Tooltip title="Видалити файл з форми">
                      <span>
                        <IconButton
                          size="small"
                          color="error"
                          disabled={disabled}
                          onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
                          aria-label="Видалити файл з форми"
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Stack>
                  {rowErrors.row ? <Alert severity="error">{rowErrors.row}</Alert> : null}
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
                      gap: 1,
                    }}
                  >
                    <TextField
                      label="Оригінальна назва"
                      size="small"
                      value={row.originalName}
                      onChange={(event) =>
                        onChange(replaceRow(rows, row.id, { originalName: event.target.value }))
                      }
                      disabled={disabled}
                      error={rowErrors.originalName !== undefined}
                      helperText={rowErrors.originalName ?? 'Потрібна назва або абсолютний шлях.'}
                      fullWidth
                    />
                    <TextField
                      label="Оригінальний абсолютний шлях"
                      size="small"
                      value={row.originalAbsolutePath}
                      onChange={(event) =>
                        onChange(
                          replaceRow(rows, row.id, { originalAbsolutePath: event.target.value }),
                        )
                      }
                      disabled={disabled}
                      error={rowErrors.originalAbsolutePath !== undefined}
                      helperText={rowErrors.originalAbsolutePath}
                      fullWidth
                    />
                    <TextField
                      label="Оригінальний час створення"
                      type="datetime-local"
                      size="small"
                      value={row.originalCreatedAt}
                      onChange={(event) =>
                        onChange(
                          replaceRow(rows, row.id, { originalCreatedAt: event.target.value }),
                        )
                      }
                      disabled={disabled}
                      error={rowErrors.originalCreatedAt !== undefined}
                      helperText={rowErrors.originalCreatedAt}
                      InputLabelProps={{ shrink: true }}
                      fullWidth
                    />
                    <TextField
                      label="Оригінальний час зміни"
                      type="datetime-local"
                      size="small"
                      value={row.originalModifiedAt}
                      onChange={(event) =>
                        onChange(
                          replaceRow(rows, row.id, { originalModifiedAt: event.target.value }),
                        )
                      }
                      disabled={disabled}
                      error={rowErrors.originalModifiedAt !== undefined}
                      helperText={rowErrors.originalModifiedAt}
                      InputLabelProps={{ shrink: true }}
                      fullWidth
                    />
                  </Box>
                </Stack>
              </Box>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
