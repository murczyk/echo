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
import { memo, useEffect, useMemo, useState } from 'react';

import type { ModulationRec, NetworkFreqsRes } from '../../../../../Bindings';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { PowerAlert } from '../../../components/PowerAlert';
import { type NetworkFreqEditForm } from '../use-rer-network-details-neo-page.shared';
import { parseNetworkDetailsDateInput } from '../use-rer-network-details-neo-page.shared';
import { NetworkFreqActivityPeriodControl } from './NetworkFreqActivityPeriodControl';
import { NetworkFreqSummaryHeader } from './NetworkFreqSummaryHeader';
import { NEO_SELECT_MENU_PROPS } from './dropdownProps';

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
  disableRestoreFocus?: boolean;
};

function NetworkFreqEditDrawerComponent({
  open,
  form,
  freq,
  saving,
  error,
  modulations,
  onClose,
  onChange,
  onSave,
  disableRestoreFocus = false,
}: Props) {
  const titleId = 'network-freq-edit-drawer-title';
  const [activePeriodTouched, setActivePeriodTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setActivePeriodTouched(false);
  }, [open, form?.networkFreqId]);

  const activeFromValidationError = form && parseNetworkDetailsDateInput(form.activeFrom) === null ? 'Потрібно вказати дату початку' : null;
  const activeToValidationError = form && form.activeTo.trim() !== '' && parseNetworkDetailsDateInput(form.activeTo) === null ? 'Потрібно вказати дату завершення' : null;
  const activeFromError = activePeriodTouched ? activeFromValidationError : null;
  const activeToError = activePeriodTouched ? activeToValidationError : null;
  const formBlocked = saving;
  const saveDisabled = saving || !form || activeFromValidationError !== null || activeToValidationError !== null;

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
        disableRestoreFocus,
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
                  MenuProps={NEO_SELECT_MENU_PROPS}
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
                  MenuProps={NEO_SELECT_MENU_PROPS}
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

              <NetworkFreqActivityPeriodControl
                activeFrom={form.activeFrom}
                activeTo={form.activeTo}
                onActiveFromChange={(nextValue) => onChange({ ...form, activeFrom: nextValue })}
                onActiveToChange={(nextValue) => onChange({ ...form, activeTo: nextValue })}
                onActiveFromBlur={() => setActivePeriodTouched(true)}
                onActiveToBlur={() => setActivePeriodTouched(true)}
                disabled={formBlocked}
                activeFromError={activeFromError !== null}
                activeFromHelperText={activeFromError ?? undefined}
                activeToError={activeToError !== null}
                activeToHelperText={activeToError ?? undefined}
              />
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
        <Button onClick={onSave} variant="contained" disabled={saveDisabled}>
          {saving ? <CircularProgress size={16} color="inherit" /> : 'Зберегти'}
        </Button>
      </Box>
    </Drawer>
  );
}

export const NetworkFreqEditDrawer = memo(NetworkFreqEditDrawerComponent);
