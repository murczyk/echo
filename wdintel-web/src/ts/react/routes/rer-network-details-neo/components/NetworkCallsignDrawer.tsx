import {
  Box,
  Button,
  Checkbox,
  ButtonBase,
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
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';

import type { Source } from '../../../../../Bindings';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { PowerAlert } from '../../../components/PowerAlert';
import type { NetworkOption } from '../use-rer-network-details-neo-page.shared';
import { NetworkCallsignSourceChip, sortNetworkCallsignSources } from './NetworkCallsignSourceUi';
import {
  normalizeCallsignDisplay,
  NetworkCallsignSourceId,
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

function MainRadioStationControl({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Box
      sx={(theme) => ({
        border: '1px solid',
        borderColor: checked ? theme.palette.warning.main : 'divider',
        borderRadius: 2,
        bgcolor: checked ? 'action.selected' : 'transparent',
        px: 1.25,
        py: 0.75,
      })}
    >
      <FormControlLabel
        sx={{
          m: 0,
          width: '100%',
          alignItems: 'center',
          '& .MuiFormControlLabel-label': {
            width: '100%',
          },
        }}
        control={
          <Checkbox
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
            disabled={disabled}
            size="small"
          />
        }
        label={
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap sx={{ fontSize: '0.95rem', fontWeight: 600 }}>
              Головна радіостанція
            </Typography>
            {checked ? <StarIcon fontSize="small" sx={{ color: 'warning.main' }} /> : <StarBorderIcon fontSize="small" />}
          </Stack>
        }
      />
    </Box>
  );
}

function CallsignStatusControl({
  developing,
  disabled,
  onChange,
}: {
  developing: boolean;
  disabled: boolean;
  onChange: (nextDeveloping: boolean) => void;
}) {
  const verifiedSelected = !developing;
  const developingSelected = developing;

  return (
    <Box
      sx={(theme) => ({
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)',
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 0.75,
        p: 0.5,
      })}
    >
      <ButtonBase
        disabled={disabled}
        onClick={() => onChange(false)}
        sx={(theme) => ({
          minHeight: 38,
          borderRadius: 1.5,
          px: 1.5,
          py: 0.8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0.75,
          fontSize: '0.9rem',
          fontWeight: 600,
          color: verifiedSelected ? theme.palette.success.contrastText : theme.palette.text.secondary,
          bgcolor: verifiedSelected ? theme.palette.success.main : 'transparent',
          boxShadow: verifiedSelected ? `inset 0 0 0 1px ${theme.palette.success.dark}` : 'none',
          transition: theme.transitions.create(['background-color', 'box-shadow', 'color'], {
            duration: theme.transitions.duration.shortest,
          }),
          '&:hover': {
            bgcolor: verifiedSelected ? theme.palette.success.main : theme.palette.action.hover,
          },
        })}
      >
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: verifiedSelected ? 'common.white' : 'text.disabled' }} />
        <Typography variant="body2" sx={{ fontWeight: 700, color: 'inherit', fontSize: '0.9rem' }}>
          Верифіковано
        </Typography>
      </ButtonBase>
      <ButtonBase
        disabled={disabled}
        onClick={() => onChange(true)}
        sx={(theme) => ({
          minHeight: 38,
          borderRadius: 1.5,
          px: 1.5,
          py: 0.8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0.75,
          fontSize: '0.9rem',
          fontWeight: 600,
          color: developingSelected ? theme.palette.warning.contrastText : theme.palette.text.secondary,
          bgcolor: developingSelected ? theme.palette.warning.main : 'transparent',
          boxShadow: developingSelected ? `inset 0 0 0 1px ${theme.palette.warning.dark}` : 'none',
          transition: theme.transitions.create(['background-color', 'box-shadow', 'color'], {
            duration: theme.transitions.duration.shortest,
          }),
          '&:hover': {
            bgcolor: developingSelected ? theme.palette.warning.main : theme.palette.action.hover,
          },
        })}
      >
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: developingSelected ? 'common.white' : 'text.disabled' }} />
        <Typography variant="body2" sx={{ fontWeight: 700, color: 'inherit', fontSize: '0.9rem' }}>
          В дорозвідці
        </Typography>
      </ButtonBase>
    </Box>
  );
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
  const isRoSource = sourceId === NetworkCallsignSourceId.RO;
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

              <MainRadioStationControl
                checked={form.mainRadioStation}
                disabled={saving}
                onChange={(nextMainRadioStation) => updateForm(form, { mainRadioStation: nextMainRadioStation }, onChange)}
              />

              <Stack spacing={1}>
                <Typography variant="body2" color="text.secondary">
                  Статус
                </Typography>
                <CallsignStatusControl
                  developing={form.developing}
                  disabled={saving}
                  onChange={(nextDeveloping) => updateForm(form, { developing: nextDeveloping }, onChange)}
                />
              </Stack>

              <Stack spacing={1}>
                <Typography variant="body2" color="text.secondary">
                  Джерело
                </Typography>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  {sortNetworkCallsignSources(sources).map((source) => (
                    <NetworkCallsignSourceChip
                      key={source.id}
                      source={source}
                      selected={sourceId === source.id}
                      disabled={saving}
                      onClick={() => updateForm(form, { sourceId: sourceId === source.id ? null : source.id }, onChange)}
                    />
                  ))}
                </Stack>
              </Stack>

              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                alignItems={{ xs: 'stretch', sm: 'center' }}
              >
                <FormControl fullWidth size="small" disabled={saving} sx={{ minWidth: 0 }}>
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
                <Box
                  component="label"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 1,
                    flexShrink: 0,
                    cursor: saving ? 'default' : 'pointer',
                    userSelect: 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Checkbox
                    checked={form.unitDeveloping}
                    onChange={(event) => updateForm(form, { unitDeveloping: event.target.checked }, onChange)}
                    disabled={saving}
                  />
                  <Typography variant="body1">В дорозвідці</Typography>
                </Box>
              </Stack>

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
