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
  Typography,
} from '@mui/material';
import type { SelectChangeEvent } from '@mui/material/Select';
import { memo, useMemo } from 'react';

import type { ModulationRec, NetworkFreqsRes } from '../../../../../Bindings';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { PowerAlert } from '../../../components/PowerAlert';
import { type NetworkFreqEditForm } from '../use-rer-network-details-neo-page.shared';
import { NetworkFreqActivityControl } from './NetworkFreqActivityControl';
import { NetworkFreqDatePickerField } from './NetworkFreqDatePickerField';
import { NetworkFreqSummaryHeader } from './NetworkFreqSummaryHeader';

type Props = {
  open: boolean;
  form: NetworkFreqEditForm | null;
  freq: NetworkFreqsRes | null;
  saving: boolean;
  error: string | null;
  modulations: ModulationRec[];
  onClose: () => void;
  onChange: (next: NetworkFreqEditForm | null) => void;
  onSave: () => void;
};

function NetworkFreqEditDrawerComponent({ open, form, freq, saving, error, modulations, onClose, onChange, onSave }: Props) {
  const titleId = 'network-freq-edit-drawer-title';
  const formBlocked = saving;

  const modulationItems = useMemo(
    () =>
      modulations.map((modulation) => (
        <MenuItem key={modulation.id} value={String(modulation.id)}>
          {modulation.name}
        </MenuItem>
      )),
    [modulations],
  );

  const handleModulationChange = (event: SelectChangeEvent<string>) => {
    if (!form) return;
    const value = event.target.value.trim();
    onChange({ ...form, modulationId: value === '' ? null : Number(value) });
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
            width: { xs: '100vw', sm: 640 },
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
          Редагувати частоту
        </Typography>
      </Box>

      <NetworkFreqSummaryHeader freq={freq} />

      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}

          {form ? (
            <>
              <FormControl fullWidth size="small" disabled={formBlocked}>
                <InputLabel id="network-freq-edit-kind-label">Тип</InputLabel>
                <Select
                  labelId="network-freq-edit-kind-label"
                  label="Тип"
                  value={form.kind}
                  onChange={(event) => onChange({ ...form, kind: String(event.target.value) as NetworkFreqEditForm['kind'] })}
                >
                  <MenuItem value="DMR">DMR</MenuItem>
                  <MenuItem value="DMRe">DMRe</MenuItem>
                  <MenuItem value="NFM">NFM</MenuItem>
                </Select>
              </FormControl>

              <FormControl fullWidth size="small" disabled={formBlocked}>
                <InputLabel id="network-freq-edit-modulation-label" shrink>
                  Модуляція
                </InputLabel>
                <Select
                  labelId="network-freq-edit-modulation-label"
                  label="Модуляція"
                  displayEmpty
                  value={form.modulationId === null ? '' : String(form.modulationId)}
                  onChange={handleModulationChange}
                  renderValue={(value) => {
                    if (value === '') {
                      return <span style={{ opacity: 0.7 }}>Виберіть модуляцію</span>;
                    }

                    return modulations.find((modulation) => String(modulation.id) === String(value))?.name ?? value;
                  }}
                >
                  {modulationItems}
                </Select>
              </FormControl>

              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <NetworkFreqDatePickerField
                  label="Активна з"
                  value={form.activeFrom}
                  onChange={(nextValue) => onChange({ ...form, activeFrom: nextValue })}
                  disabled={formBlocked}
                />

                <NetworkFreqActivityControl
                  activeTo={form.activeTo}
                  onChange={(nextValue) => onChange({ ...form, activeTo: nextValue })}
                  disabled={formBlocked}
                />
              </Box>
            </>
          ) : null}
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
        <Button onClick={onSave} variant="contained" disabled={saving || !form}>
          {saving ? <CircularProgress size={16} color="inherit" /> : 'Зберегти'}
        </Button>
      </Box>
    </Drawer>
  );
}

export const NetworkFreqEditDrawer = memo(NetworkFreqEditDrawerComponent);
