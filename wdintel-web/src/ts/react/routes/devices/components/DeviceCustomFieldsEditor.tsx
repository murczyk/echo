import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { Box, Stack, TextField, Tooltip, Typography } from '@mui/material';

import { PowerButton } from '../../../components/PowerButton';
import { PowerIconButton } from '../../../components/PowerIconButton';

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

export function DeviceCustomFieldsEditor({ rows, errors, disabled, onChange }: Props) {
  const maxReached = rows.length >= DEVICE_CUSTOM_FIELDS_MAX_COUNT;

  return (
    <Stack spacing={1.25}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
        <Typography variant="subtitle2">Кастомні поля</Typography>
        <PowerButton
          size="small"
          startIcon={<AddIcon />}
          disabled={disabled || maxReached}
          onClick={() => onChange([...rows, createDeviceCustomFieldDraft()])}
        >
          Додати поле
        </PowerButton>
      </Stack>

      {rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Кастомні поля відсутні.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {rows.map((row) => {
            const rowErrors = errors[row.id];
            return (
              <Box
                key={row.id}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1fr) minmax(0, 1fr) auto' },
                  alignItems: 'start',
                  gap: 1,
                }}
              >
                <TextField
                  label="Ключ"
                  value={row.key}
                  disabled={disabled}
                  fullWidth
                  size="small"
                  required
                  error={rowErrors?.key !== undefined}
                  helperText={rowErrors?.key}
                  onChange={(event) =>
                    onChange(
                      rows.map((item) =>
                        item.id === row.id ? { ...item, key: event.target.value } : item,
                      ),
                    )
                  }
                />
                <TextField
                  label="Значення"
                  value={row.value}
                  disabled={disabled}
                  fullWidth
                  size="small"
                  error={rowErrors?.value !== undefined}
                  helperText={rowErrors?.value}
                  onChange={(event) =>
                    onChange(
                      rows.map((item) =>
                        item.id === row.id ? { ...item, value: event.target.value } : item,
                      ),
                    )
                  }
                />
                <Tooltip title="Видалити поле">
                  <span>
                    <PowerIconButton
                      size="small"
                      color="error"
                      disabled={disabled}
                      onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
                      aria-label="Видалити поле"
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </PowerIconButton>
                  </span>
                </Tooltip>
              </Box>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
