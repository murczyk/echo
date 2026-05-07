import {
  Box,
  Button,
  CircularProgress,
  Drawer,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material/Select';
import { memo, useMemo } from 'react';

import type { Network, NetworkDescrType } from '../../../../../Bindings';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { PowerAlert } from '../../../components/PowerAlert';
import type { NetworkDescriptionForm } from '../use-rer-network-details-neo-page.shared';

type Props = {
  open: boolean;
  mode: 'create' | 'edit';
  descrType: NetworkDescrType;
  form: NetworkDescriptionForm;
  saving: boolean;
  error: string | null;
  networkFreqs: Network['freqs'];
  onClose: () => void;
  onChange: (next: NetworkDescriptionForm) => void;
  onSave: () => void;
};

function getDrawerTitle(mode: Props['mode'], descrType: NetworkDescrType): string {
  if (mode === 'edit') {
    return 'Редагувати опис';
  }

  return descrType === 'Sign' ? 'Створити розвідувальні ознаки' : "Створити обґрунтування прив'язки";
}

function getDescriptionLabel(mode: Props['mode'], descrType: NetworkDescrType): string {
  if (mode === 'edit') {
    return 'Текст опису *';
  }

  return descrType === 'Sign' ? 'Розвідувальні ознаки *' : "Обґрунтування прив'язки *";
}

function getDescriptionPlaceholder(mode: Props['mode'], descrType: NetworkDescrType): string {
  if (mode === 'edit') {
    return 'Введіть текст опису';
  }

  return descrType === 'Sign' ? 'Введіть розвідувальні ознаки' : "Введіть обґрунтування прив'язки";
}

function NetworkDescriptionDrawerComponent({
  open,
  mode,
  descrType,
  form,
  saving,
  error,
  networkFreqs,
  onClose,
  onChange,
  onSave,
  }: Props) {
  const titleId = 'network-description-drawer-title';
  const formBlocked = saving;
  const saveDisabled = saving || form.description.trim() === '';

  const frequencyItems = useMemo(() => {
    return networkFreqs.map((freq) => (
      <MenuItem key={freq.id} value={String(freq.id)}>
        {freq.freq}
      </MenuItem>
    ));
  }, [networkFreqs]);

  const handleFrequencyChange = (event: SelectChangeEvent<string>) => {
    const value = event.target.value;
    onChange({
      ...form,
      networkFreqId: value === '' ? null : Number(value),
    });
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={saving ? undefined : onClose}
      ModalProps={{
        BackdropProps: {
          sx: (theme) => pageDrawerBackdropSx(theme),
        },
      }}
      slotProps={{
        paper: {
          'aria-labelledby': titleId,
          sx: {
            width: { xs: '100vw', sm: 720 },
            maxWidth: '100vw',
            display: 'flex',
            backgroundColor: 'background.default',
            backgroundImage: 'none',
          },
        },
      }}
    >
      <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="h6" id={titleId}>
          {getDrawerTitle(mode, descrType)}
        </Typography>
      </Box>

      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5} sx={{ height: '100%' }}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

          <FormControl fullWidth size="small" disabled={formBlocked}>
            <InputLabel id="network-description-freq-label">Частота (необов&apos;язково)</InputLabel>
            <Select
              labelId="network-description-freq-label"
              label="Частота (необов'язково)"
              value={form.networkFreqId === null ? '' : String(form.networkFreqId)}
              onChange={handleFrequencyChange}
            >
              <MenuItem value="">
                <em>Без частоти</em>
              </MenuItem>
              {frequencyItems}
            </Select>
          </FormControl>

          <TextField
            label={getDescriptionLabel(mode, descrType)}
            placeholder={getDescriptionPlaceholder(mode, descrType)}
            value={form.description}
            onChange={(event) => onChange({ ...form, description: event.target.value })}
            disabled={formBlocked}
            fullWidth
            multiline
            minRows={12}
            sx={{ flex: 1 }}
          />
        </Stack>
      </Box>

      <Box
        sx={{
          p: 2.5,
          borderTop: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 2,
        }}
      >
        <Button onClick={onClose} disabled={saving}>
          Скасувати
        </Button>
        <Button onClick={onSave} variant="contained" disabled={saveDisabled}>
          {saving ? <CircularProgress size={16} color="inherit" /> : mode === 'create' ? 'Створити' : 'Зберегти'}
        </Button>
      </Box>
    </Drawer>
  );
}

export const NetworkDescriptionDrawer = memo(NetworkDescriptionDrawerComponent);
