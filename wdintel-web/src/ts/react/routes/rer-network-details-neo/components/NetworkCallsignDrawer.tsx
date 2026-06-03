import {
  Box,
  Button,
  Checkbox,
  ButtonBase,
  Drawer,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import StarIcon from '@mui/icons-material/Star';
import MilitaryTechOutlinedIcon from '@mui/icons-material/MilitaryTechOutlined';
import { useEffect, useState } from 'react';

import type { Source } from '../../../../../Bindings';
import { ELLIPSIS } from '../../../utils/misc';
import { pageDrawerBackdropSx } from '../../../components/loadingOverlayStyles';
import { PowerAlert } from '../../../components/PowerAlert';
import { SearchableOptionAutocomplete } from '../../../components/SearchableOptionAutocomplete';
import { getFrequencyFormatError, type NetworkOption } from '../use-rer-network-details-neo-page.shared';
import { NetworkCallsignSourceChip, sortNetworkCallsignSources } from './NetworkCallsignSourceUi';
import {
  normalizeCallsignDisplay,
  NetworkCallsignSourceId,
  getNetworkCallsignMarkerMode,
  getNetworkCallsignMarkerState,
  type NetworkCallsignStatus,
  type NetworkCallsignDrawerForm,
  type NetworkCallsignDrawerMode,
} from '../network-callsigns';
import { NEO_AUTOCOMPLETE_SLOT_PROPS } from './dropdownProps';

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

type MarkerOption = {
  value: ReturnType<typeof getNetworkCallsignMarkerMode>;
  label: string;
  icon: JSX.Element;
  accentColor: string;
  contrastText: string;
};

function MarkerModeControl({
  disabled,
  markerMode,
  onChange,
}: {
  disabled: boolean;
  markerMode: ReturnType<typeof getNetworkCallsignMarkerMode>;
  onChange: (next: ReturnType<typeof getNetworkCallsignMarkerMode>) => void;
}) {
  const markerOptions: MarkerOption[] = [
    {
      value: 'mainRadioStation',
      label: 'Головна радіостанція',
      icon: <StarIcon fontSize="small" sx={{ color: 'warning.main' }} />,
      accentColor: 'var(--mui-palette-warning-main)',
      contrastText: 'var(--mui-palette-warning-contrastText)',
    },
    {
      value: 'commandControl',
      label: 'Ланка управління',
      icon: <MilitaryTechOutlinedIcon fontSize="small" sx={{ color: 'info.main' }} />,
      accentColor: 'var(--mui-palette-info-main)',
      contrastText: 'var(--mui-palette-info-contrastText)',
    },
    {
      value: 'none',
      label: 'Без маркера',
      icon: <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'text.disabled' }} />,
      accentColor: 'var(--mui-palette-divider)',
      contrastText: 'var(--mui-palette-text-primary)',
    },
  ];

  return (
    <Box
      sx={(theme) => ({
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)',
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 0.75,
        p: 0.5,
      })}
    >
      {markerOptions.map((option) => {
        const selected = markerMode === option.value;
        return (
          <ButtonBase
            key={option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            sx={(theme) => ({
              minHeight: 38,
              borderRadius: 1.5,
              px: 1.25,
              py: 0.8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.75,
              fontSize: '0.9rem',
              fontWeight: 600,
              textAlign: 'left',
              color: selected ? (option.value === 'none' ? theme.palette.text.primary : option.contrastText) : theme.palette.text.secondary,
              bgcolor: selected ? (option.value === 'none' ? theme.palette.action.selected : option.accentColor) : 'transparent',
              boxShadow: selected ? `inset 0 0 0 1px ${option.value === 'none' ? theme.palette.divider : option.accentColor}` : 'none',
              transition: theme.transitions.create(['background-color', 'box-shadow', 'color'], {
                duration: theme.transitions.duration.shortest,
              }),
              '&:hover': {
                bgcolor: selected ? (option.value === 'none' ? theme.palette.action.selected : option.accentColor) : theme.palette.action.hover,
              },
            })}
          >
            {option.icon}
            <Typography variant="body2" sx={{ fontWeight: 700, color: 'inherit', fontSize: '0.9rem' }}>
              {option.label}
            </Typography>
          </ButtonBase>
        );
      })}
    </Box>
  );
}

function CallsignStatusControl({
  status,
  disabled,
  onChange,
}: {
  status: NetworkCallsignStatus;
  disabled: boolean;
  onChange: (nextStatus: NetworkCallsignStatus) => void;
}) {
  const developingSelected = status === 'developing';
  const catalogSelected = status === 'catalog';

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
        onClick={() => onChange('developing')}
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
      <ButtonBase
        disabled={disabled}
        onClick={() => onChange('catalog')}
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
          color: catalogSelected ? theme.palette.info.contrastText : theme.palette.text.secondary,
          bgcolor: catalogSelected ? theme.palette.info.main : 'transparent',
          boxShadow: catalogSelected ? `inset 0 0 0 1px ${theme.palette.info.dark}` : 'none',
          transition: theme.transitions.create(['background-color', 'box-shadow', 'color'], {
            duration: theme.transitions.duration.shortest,
          }),
          '&:hover': {
            bgcolor: catalogSelected ? theme.palette.info.main : theme.palette.action.hover,
          },
        })}
      >
        <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: catalogSelected ? 'common.white' : 'text.disabled' }} />
        <Typography variant="body2" sx={{ fontWeight: 700, color: 'inherit', fontSize: '0.9rem' }}>
          Каталог
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
  const [radioFreqTouched, setRadioFreqTouched] = useState(false);
  const [sourceTouched, setSourceTouched] = useState(false);
  const radioFreqValidationError = isRoSource && form ? getFrequencyFormatError(form.radioFreq) : null;
  const radioFreqError = radioFreqTouched ? radioFreqValidationError : null;
  const sourceValidationError = sourceId === null ? 'Джерело є обовʼязковим' : null;
  const showSourceValidationError = sourceValidationError !== null && (sourceTouched || error === sourceValidationError);
  const canSave = Boolean(
    form
      && normalizeCallsignDisplay(form.callsign) !== ''
      && sourceId !== null
      && (!isRoSource || radioFreqValidationError === null),
  );
  const title = mode === 'edit' ? 'Редагувати позивний мережі' : 'Створити позивний мережі';
  const unitOptions = [{ id: 0, label: 'Не вказано' }, ...units];
  const selectedUnitId = form?.unitId ?? 0;

  useEffect(() => {
    if (!open) return;
    setRadioFreqTouched(false);
    setSourceTouched(false);
  }, [open]);

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

              <Stack spacing={1}>
                <Typography variant="body2" color="text.secondary">
                  Маркер
                </Typography>
                <MarkerModeControl
                  disabled={saving}
                  markerMode={getNetworkCallsignMarkerMode(form)}
                  onChange={(markerMode) => updateForm(form, getNetworkCallsignMarkerState(markerMode), onChange)}
                />
              </Stack>

              <Stack spacing={1}>
                <Typography variant="body2" color="text.secondary">
                  Статус
                </Typography>
                <CallsignStatusControl
                  status={form.status}
                  disabled={saving}
                  onChange={(nextStatus) => updateForm(
                    form,
                    {
                      status: nextStatus,
                      developing: nextStatus === 'developing',
                    },
                    onChange,
                  )}
                />
              </Stack>

              <Stack spacing={1}>
                <Typography variant="body2" color="text.secondary">
                  Джерело *
                </Typography>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  {sortNetworkCallsignSources(sources).map((source) => (
                    <NetworkCallsignSourceChip
                      key={source.id}
                      source={source}
                      selected={sourceId === source.id}
                      disabled={saving}
                      onClick={() => {
                        setSourceTouched(true);
                        updateForm(form, { sourceId: sourceId === source.id ? null : source.id }, onChange);
                      }}
                    />
                  ))}
                </Stack>
                {showSourceValidationError ? (
                  <Typography
                    data-testid="network-callsign-source-error"
                    variant="caption"
                    color="error.main"
                    sx={{ ml: 0.5 }}
                  >
                    {sourceValidationError}
                  </Typography>
                ) : null}
              </Stack>

              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                alignItems={{ xs: 'stretch', sm: 'center' }}
              >
                <SearchableOptionAutocomplete
                  label="Підрозділ"
                  options={unitOptions}
                  valueId={selectedUnitId}
                  onValueIdChange={(unitId) => updateForm(form, { unitId: unitId === 0 ? null : unitId }, onChange)}
                  getOptionLabel={(unit) => unit.label}
                  disabled={saving}
                  placeholder="Оберіть підрозділ"
                  slotProps={NEO_AUTOCOMPLETE_SLOT_PROPS}
                />
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
                    onBlur={() => setRadioFreqTouched(true)}
                    disabled={saving}
                    fullWidth
                    size="small"
                    placeholder="Напр. 145.5000"
                    error={radioFreqError !== null}
                    helperText={radioFreqError ?? ' '}
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
          {saving ? `Збереження${ELLIPSIS}` : 'Зберегти'}
        </Button>
      </Box>
    </Drawer>
  );
}
