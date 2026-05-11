import {
  Box,
  Button,
  Checkbox,
  Drawer,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import type { Source } from '../../../../../Bindings';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { PowerAlert } from '../../../components/PowerAlert';
import type { NetworkOption } from '../use-rer-network-details-neo-page.shared';
import {
  normalizeCallsignDisplay,
  type NetworkCallsignDrawerForm,
  type NetworkCallsignDrawerMode,
} from '../network-callsigns';

type Props = {
  open: boolean;
  mode: NetworkCallsignDrawerMode;
  form: NetworkCallsignDrawerForm | null;
  sources: Source[];
  units: NetworkOption[];
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onChange: (next: NetworkCallsignDrawerForm | null) => void;
  onSave: () => void;
};

function updateForm(
  form: NetworkCallsignDrawerForm | null,
  next: Partial<NetworkCallsignDrawerForm>,
  onChange: (next: NetworkCallsignDrawerForm | null) => void,
) {
  if (!form) return;
  onChange({ ...form, ...next });
}

export function NetworkCallsignDrawer({
  open,
  mode,
  form,
  sources,
  units,
  saving,
  error,
  onClose,
  onChange,
  onSave,
}: Props) {
  const titleId = 'network-callsign-drawer-title';
  const sourceId = form?.sourceId ?? null;
  const isRoSource = sourceId === 2;
  const canSave = Boolean(
    form &&
      normalizeCallsignDisplay(form.callsign) !== '' &&
      (!isRoSource || form.radioFreq.trim() !== ''),
  );
  const title = mode === 'edit' ? 'Редагувати позивний мережі' : 'Створити позивний мережі';
  const selectedUnitId = form?.unitId ?? null;

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
            width: { xs: '100vw', sm: 680 },
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
          {title}
        </Typography>
      </Box>

      <Box sx={{ p: 2.5, flex: 1, overflowY: 'auto' }}>
        <Stack spacing={2.5}>
          {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
          {form ? (
            <>
              <TextField
                label="Позивний *"
                value={form.callsign}
                onChange={(event) => onChange({ ...form, callsign: normalizeCallsignDisplay(event.target.value) })}
                disabled={saving}
                fullWidth
                size="small"
                placeholder="Введіть позивний"
              />

              <FormControl fullWidth size="small" disabled={saving}>
                <InputLabel id="network-callsign-source-label">Джерело</InputLabel>
                <Select
                  labelId="network-callsign-source-label"
                  label="Джерело"
                  value={sourceId ?? ''}
                  onChange={(event) => {
                    const rawValue = event.target.value;
                    const nextSourceId = rawValue === '' ? null : Number(rawValue);
                    updateForm(form, { sourceId: nextSourceId }, onChange);
                  }}
                >
                  <MenuItem value="">
                    <em>Виберіть джерело (необов'язково)</em>
                  </MenuItem>
                  {sources.map((source) => (
                    <MenuItem key={source.id} value={source.id}>
                      {source.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <FormControl fullWidth size="small" disabled={saving}>
                <InputLabel id="network-callsign-unit-label">Підрозділ</InputLabel>
                <Select
                  labelId="network-callsign-unit-label"
                  label="Підрозділ"
                  value={selectedUnitId ?? ''}
                  onChange={(event) => {
                    const rawValue = event.target.value;
                    onChange({ ...form, unitId: rawValue === '' ? null : Number(rawValue) });
                  }}
                >
                  <MenuItem value="">
                    <em>Оберіть підрозділ</em>
                  </MenuItem>
                  {units.map((unit) => (
                    <MenuItem key={unit.id} value={unit.id}>
                      {unit.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              <TextField
                label="Посада"
                value={form.position}
                onChange={(event) => updateForm(form, { position: event.target.value }, onChange)}
                disabled={saving}
                fullWidth
                size="small"
                placeholder="Введіть посаду"
              />

              <TextField
                label="Коментар"
                value={form.comment}
                onChange={(event) => updateForm(form, { comment: event.target.value }, onChange)}
                disabled={saving}
                fullWidth
                multiline
                minRows={3}
                size="small"
                placeholder="Введіть коментар"
              />

              <Stack spacing={1}>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={form.unitDeveloping}
                      onChange={(event) => updateForm(form, { unitDeveloping: event.target.checked }, onChange)}
                      disabled={saving}
                    />
                  }
                  label="Підрозділ в дорозвідці"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={form.developing}
                      onChange={(event) => updateForm(form, { developing: event.target.checked }, onChange)}
                      disabled={saving}
                    />
                  }
                  label="Позначити як позивний в дорозвідці"
                />
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={form.mainRadioStation}
                      onChange={(event) => updateForm(form, { mainRadioStation: event.target.checked }, onChange)}
                      disabled={saving}
                    />
                  }
                  label="Головна радіостанція"
                />
              </Stack>

              {isRoSource ? (
                <Stack spacing={0.5}>
                  <TextField
                    label="Частота *"
                    value={form.radioFreq}
                    onChange={(event) => updateForm(form, { radioFreq: event.target.value }, onChange)}
                    disabled={saving}
                    fullWidth
                    size="small"
                    placeholder="Напр. 145.500"
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 0 }}>
                    Для джерела "РО" частота є обов’язковою.
                  </Typography>
                </Stack>
              ) : null}
            </>
          ) : null}
        </Stack>
      </Box>

      <Box sx={{ p: 2.5, borderTop: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button onClick={onClose} disabled={saving}>
          Скасувати
        </Button>
        <Button variant="contained" onClick={onSave} disabled={saving || !canSave}>
          {saving ? 'Збереження…' : 'Зберегти'}
        </Button>
      </Box>
    </Drawer>
  );
}
