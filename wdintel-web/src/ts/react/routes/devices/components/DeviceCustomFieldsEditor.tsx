import AddIcon from '@mui/icons-material/Add';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { Box, Button, IconButton, Stack, TextField, Tooltip, Typography } from '@mui/material';

import {
  createDeviceCustomFieldDraft,
  DEVICE_CUSTOM_FIELDS_MAX_COUNT,
  type DeviceCustomFieldDraft,
  type DeviceCustomFieldDraftError,
} from '../device-form';

type Props = {
  rows: DeviceCustomFieldDraft[];
  errors: Record<string, DeviceCustomFieldDraftError>;
  disabled: boolean;
  onChange: (rows: DeviceCustomFieldDraft[]) => void;
};

function replaceRow(
  rows: DeviceCustomFieldDraft[],
  rowId: string,
  patch: Partial<DeviceCustomFieldDraft>,
): DeviceCustomFieldDraft[] {
  return rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row));
}

function moveRow(
  rows: DeviceCustomFieldDraft[],
  index: number,
  delta: -1 | 1,
): DeviceCustomFieldDraft[] {
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= rows.length) return rows;
  const next = [...rows];
  const [row] = next.splice(index, 1);
  next.splice(nextIndex, 0, row);
  return next;
}

export function DeviceCustomFieldsEditor({ rows, errors, disabled, onChange }: Props) {
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
        <Box>
          <Typography variant="subtitle2">Користувацькі поля</Typography>
          <Typography variant="caption" color="text.secondary">
            Порядок зберігається як у списку. Максимум {DEVICE_CUSTOM_FIELDS_MAX_COUNT}.
          </Typography>
        </Box>
        <Button
          size="small"
          startIcon={<AddIcon />}
          onClick={() => onChange([...rows, createDeviceCustomFieldDraft()])}
          disabled={disabled || rows.length >= DEVICE_CUSTOM_FIELDS_MAX_COUNT}
        >
          Додати поле
        </Button>
      </Stack>

      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Користувацькі поля не додані.
        </Typography>
      ) : (
        <Stack spacing={1.25}>
          {rows.map((row, index) => {
            const rowErrors = errors[row.id] ?? {};
            return (
              <Box
                key={row.id}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr) auto' },
                  gap: 1,
                  alignItems: 'flex-start',
                }}
              >
                <TextField
                  label="Назва поля"
                  size="small"
                  value={row.label}
                  onChange={(event) =>
                    onChange(replaceRow(rows, row.id, { label: event.target.value }))
                  }
                  disabled={disabled}
                  error={rowErrors.label !== undefined}
                  helperText={rowErrors.label}
                  required
                  fullWidth
                />
                <TextField
                  label="Значення"
                  size="small"
                  value={row.value}
                  onChange={(event) =>
                    onChange(replaceRow(rows, row.id, { value: event.target.value }))
                  }
                  disabled={disabled}
                  error={rowErrors.value !== undefined}
                  helperText={rowErrors.value}
                  fullWidth
                  multiline
                  minRows={1}
                  maxRows={4}
                />
                <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                  <Tooltip title="Вище">
                    <span>
                      <IconButton
                        size="small"
                        disabled={disabled || index === 0}
                        onClick={() => onChange(moveRow(rows, index, -1))}
                        aria-label="Перемістити поле вище"
                      >
                        <ArrowUpwardIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title="Нижче">
                    <span>
                      <IconButton
                        size="small"
                        disabled={disabled || index === rows.length - 1}
                        onClick={() => onChange(moveRow(rows, index, 1))}
                        aria-label="Перемістити поле нижче"
                      >
                        <ArrowDownwardIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Tooltip title="Видалити поле">
                    <span>
                      <IconButton
                        size="small"
                        color="error"
                        disabled={disabled}
                        onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
                        aria-label="Видалити користувацьке поле"
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>
              </Box>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
