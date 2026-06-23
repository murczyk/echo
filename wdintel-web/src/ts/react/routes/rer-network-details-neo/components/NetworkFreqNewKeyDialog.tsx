import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
} from '@mui/material';
import type { ModulationRec } from '../../../../../Bindings';
import { PowerAlert } from '../../../components/PowerAlert';

type Props = {
  open: boolean;
  title: string;
  saving: boolean;
  keyValue: string;
  descriptionValue: string;
  modulationId: number | null;
  modulationOptions: ModulationRec[];
  keyError?: string | null;
  onClose: () => void;
  onKeyChange: (nextValue: string) => void;
  onKeyBlur: () => void;
  onDescriptionChange: (nextValue: string) => void;
  onModulationChange: (nextValue: number | null) => void;
  onCreate: () => void;
  createDisabled?: boolean;
  disableRestoreFocus?: boolean;
};

const compactTextFieldSx = (theme: any) => ({
  '& .MuiOutlinedInput-root': {
    height: 40,
    minHeight: 40,
    fontSize: '0.875rem',
    '&.Mui-disabled': {
      backgroundColor: theme.palette.mode === 'light' ? theme.palette.action.disabledBackground : 'transparent',
      '& .MuiOutlinedInput-notchedOutline': {
        borderColor: theme.palette.mode === 'light' ? theme.palette.grey[400] : theme.palette.action.disabled,
      },
    },
    '& input': {
      py: 0,
      px: 1.75,
      fontSize: '0.875rem',
      '&::placeholder': {
        opacity: 1,
        color: theme.palette.mode === 'light' ? theme.palette.grey[700] : theme.palette.text.secondary,
      },
    },
  },
});

const compactSelectSx = (theme: any) => ({
  '&.MuiOutlinedInput-root': {
    height: 40,
    minHeight: 40,
    fontSize: '0.875rem',
    '&.Mui-disabled': {
      backgroundColor: theme.palette.mode === 'light' ? theme.palette.action.disabledBackground : 'transparent',
      '& .MuiOutlinedInput-notchedOutline': {
        borderColor: theme.palette.mode === 'light' ? theme.palette.grey[400] : theme.palette.action.disabled,
      },
    },
  },
  '& .MuiSelect-select': {
    display: 'flex',
    alignItems: 'center',
    minHeight: '40px',
    py: 0,
    px: 1.75,
    fontSize: '0.875rem',
  },
  '& .MuiSelect-icon': {
    top: 'calc(50% - 0.5em)',
  },
});

export function NetworkFreqNewKeyDialog({
  open,
  title,
  saving,
  keyValue,
  descriptionValue,
  modulationId,
  modulationOptions,
  keyError,
  onClose,
  onKeyChange,
  onKeyBlur,
  onDescriptionChange,
  onModulationChange,
  onCreate,
  createDisabled = false,
  disableRestoreFocus = false,
}: Props) {
  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm" disableRestoreFocus={disableRestoreFocus}>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField
            label="Ключ"
            required
            placeholder="A-Z, 0-9 (4-64 символи)"
            value={keyValue}
            onChange={(event) => onKeyChange(event.target.value)}
            onBlur={onKeyBlur}
            disabled={saving}
            fullWidth
            size="small"
            error={keyError !== null && keyError !== undefined}
            helperText={keyError ?? undefined}
            sx={compactTextFieldSx}
          />
          <TextField
            label="Опис"
            value={descriptionValue}
            onChange={(event) => onDescriptionChange(event.target.value)}
            disabled={saving}
            fullWidth
            size="small"
            sx={compactTextFieldSx}
          />
          <FormControl fullWidth disabled={saving} size="small">
            <InputLabel id="network-freq-new-key-modulation-label">Модуляція</InputLabel>
            <Select
              labelId="network-freq-new-key-modulation-label"
              label="Модуляція"
              value={modulationId === null ? '' : String(modulationId)}
              onChange={(event) => {
                const value = event.target.value.trim();
                onModulationChange(value === '' ? null : Number(value));
              }}
              sx={compactSelectSx}
            >
              <MenuItem value="">
                <em>Не вибрано</em>
              </MenuItem>
              {modulationOptions.map((modulation) => (
                <MenuItem key={modulation.id} value={String(modulation.id)}>
                  {modulation.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <PowerAlert severity="info" autoHideDuration={null}>
            Ключ буде додано до системи одразу після створення, навіть якщо частоту не буде збережено.
          </PowerAlert>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 3 }}>
        <Button onClick={onClose} disabled={saving}>
          Скасувати
        </Button>
        <Button onClick={onCreate} variant="contained" disabled={saving || createDisabled}>
          {saving ? <CircularProgress size={16} color="inherit" /> : 'Створити'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
