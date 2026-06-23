import ExpandMoreOutlinedIcon from '@mui/icons-material/ExpandMoreOutlined';
import { Box, ButtonBase, FormControl, InputLabel, MenuItem, Select, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import type { ModulationRec } from '../../../../../Bindings';
import { NetworkFreqActivityPeriodControl } from './NetworkFreqActivityPeriodControl';
import { PowerChip } from '../../../components/PowerChip';
import type { NetworkFreqKind } from '../use-rer-network-details-neo-page.types';

type Props = {
  mode: 'create' | 'edit';
  saving: boolean;
  kind: NetworkFreqKind;
  modulationId: number | null;
  freq: string;
  activeFrom: string;
  activeTo: string;
  freqError?: string | null;
  activeFromError?: string | null;
  activeToError?: string | null;
  onKindChange: (kind: NetworkFreqKind) => void;
  onModulationChange: (modulationId: number | null) => void;
  onActiveFromChange: (nextValue: string) => void;
  onActiveToChange: (nextValue: string) => void;
  onActiveFromBlur?: () => void;
  onActiveToBlur?: () => void;
  onFreqChange?: (nextValue: string) => void;
  onFreqBlur?: () => void;
  modulations: ModulationRec[];
  keysSection: ReactNode;
};

type DrawerSectionProps = {
  title: string;
  hint: string;
  expanded: boolean;
  disabled?: boolean;
  onToggle: () => void;
  children: ReactNode;
};

type ChipOption = {
  value: string;
  label: string;
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

function DrawerSection({ title, hint, expanded, disabled = false, onToggle, children }: DrawerSectionProps) {
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
      <ButtonBase
        disabled={disabled}
        onClick={onToggle}
        sx={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1.5,
          px: 1.75,
          py: 1.25,
          textAlign: 'left',
          bgcolor: 'background.paper',
          opacity: disabled ? 0.7 : 1,
        }}
      >
        <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap sx={{ minWidth: 0, flexWrap: 'wrap' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {title}
          </Typography>
          <Typography variant="body2" sx={(theme) => ({ color: theme.palette.mode === 'light' ? theme.palette.grey[700] : theme.palette.text.secondary })}>
            {hint}
          </Typography>
        </Stack>
        <ExpandMoreOutlinedIcon
          sx={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease',
            flexShrink: 0,
          }}
        />
      </ButtonBase>
      {expanded && !disabled ? <Box sx={{ p: 1.75 }}>{children}</Box> : null}
    </Box>
  );
}

function ChipChoiceGroup({
  label,
  required = false,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  required?: boolean;
  value: string;
  options: ChipOption[];
  disabled?: boolean;
  onChange: (nextValue: string) => void;
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 700, textTransform: 'uppercase' }}>
        {label}
        {required ? ' *' : ''}
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {options.map((option) => (
          <PowerChip
            key={option.value}
            label={option.label}
            selected={option.value === value}
            interactive={!disabled}
            onClick={disabled ? undefined : () => onChange(option.value)}
          />
        ))}
      </Box>
    </Box>
  );
}

function isDmrModulationName(name: string): boolean {
  const normalized = name.trim().toUpperCase();
  if (normalized === '') return false;
  return normalized.startsWith('DMR') || normalized.includes(' DMR ') || normalized.includes(' DMR') || normalized.includes('(DMR') || normalized.includes('/DMR');
}

export function isDmrModulationId(modulations: ModulationRec[], modulationId: number | null): boolean {
  if (modulationId === null) return false;
  const selectedModulation = modulations.find((modulation) => modulation.id === modulationId);
  if (!selectedModulation) return false;
  return isDmrModulationName(selectedModulation.name);
}

export function NetworkFreqFormFields({
  mode,
  saving,
  kind,
  modulationId,
  freq,
  activeFrom,
  activeTo,
  freqError,
  activeFromError,
  activeToError,
  onKindChange,
  onModulationChange,
  onActiveFromChange,
  onActiveToChange,
  onActiveFromBlur,
  onActiveToBlur,
  onFreqChange,
  onFreqBlur,
  modulations,
  keysSection,
}: Props) {
  const [technicalExpanded, setTechnicalExpanded] = useState(false);
  const [deviationMode, setDeviationMode] = useState<'central' | 'offset'>('central');
  const isDmrModulation = isDmrModulationId(modulations, modulationId);
  const freqLabel = 'Частота *';
  const freqDisabled = saving || mode === 'edit';
  const deviationSelectValue = freq.trim();
  const showDeviationPlaceholder = deviationSelectValue === '';

  useEffect(() => {
    if (!isDmrModulation) {
      setTechnicalExpanded(false);
    }
  }, [isDmrModulation]);

  const modulationItems = useMemo<ChipOption[]>(
    () => [{ value: '', label: 'Не визначено' }, ...modulations.map((modulation) => ({ value: String(modulation.id), label: modulation.name }))],
    [modulations],
  );

  return (
    <Stack spacing={2}>
      <Typography variant="subtitle1" sx={{ fontWeight: 700, textTransform: 'uppercase' }}>
        Основні дані
      </Typography>

      <TextField
        label={freqLabel}
        placeholder="Напр. 148.2500"
        value={freq}
        onChange={onFreqChange ? (event) => onFreqChange(event.target.value) : undefined}
        onBlur={onFreqBlur}
        disabled={freqDisabled}
        inputProps={mode === 'edit' ? { readOnly: true } : undefined}
        size="small"
        fullWidth
        error={freqError !== null && freqError !== undefined}
        helperText={freqError ?? undefined}
        sx={compactTextFieldSx}
      />

      <NetworkFreqActivityPeriodControl
        activeFrom={activeFrom}
        activeTo={activeTo}
        onActiveFromChange={onActiveFromChange}
        onActiveToChange={onActiveToChange}
        onActiveFromBlur={onActiveFromBlur}
        onActiveToBlur={onActiveToBlur}
        disabled={saving}
        required
        activeFromError={activeFromError !== null && activeFromError !== undefined}
        activeFromHelperText={activeFromError ?? undefined}
        activeToError={activeToError !== null && activeToError !== undefined}
        activeToHelperText={activeToError ?? undefined}
      />

      <ChipChoiceGroup
        label="Тип"
        required
        value={kind}
        disabled={saving}
        options={[
          { value: 'DMR', label: 'DMR' },
          { value: 'DMRe', label: 'DMRe' },
          { value: 'NFM', label: 'NFM' },
        ]}
        onChange={(nextValue) => onKindChange(nextValue as NetworkFreqKind)}
      />

      <ChipChoiceGroup
        label="Модуляція"
        value={modulationId === null ? '' : String(modulationId)}
        disabled={saving}
        options={modulationItems}
        onChange={(nextValue) => onModulationChange(nextValue === '' ? null : Number(nextValue))}
      />

      {keysSection}

      <DrawerSection
        title="ТЕХНІЧНІ ДАНІ"
        hint={isDmrModulation ? 'не обовʼязково' : 'доступно лише для DMR'}
        expanded={technicalExpanded}
        disabled={!isDmrModulation}
        onToggle={() => setTechnicalExpanded((current) => !current)}
      >
        <Stack spacing={2}>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, opacity: 0.72 }}>
            <TextField label="Rx" value={freq ?? ''} disabled fullWidth size="small" sx={compactTextFieldSx} />
            <TextField label="Tx" value="" disabled fullWidth size="small" sx={compactTextFieldSx} />
          </Box>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 2, opacity: 0.72 }}>
            <TextField label="CC" value="" disabled fullWidth size="small" sx={compactTextFieldSx} />
            <TextField label="Slot" value="" disabled fullWidth size="small" sx={compactTextFieldSx} />
            <TextField label="Group ID" value="" disabled fullWidth size="small" sx={compactTextFieldSx} />
          </Box>

          <Box sx={{ opacity: 0.72 }}>
            <TextField label="Channel" value="" disabled fullWidth size="small" sx={compactTextFieldSx} />
          </Box>

        </Stack>
      </DrawerSection>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, textTransform: 'uppercase' }}>
          ДЕВІАЦІЇ
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography variant="body2" color="text.secondary">
            Мод.
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            <PowerChip
              label="Центральна частота"
              selected={deviationMode === 'central'}
              interactive={!saving}
              onClick={saving ? undefined : () => setDeviationMode('central')}
            />
            <PowerChip
              label="Девіація до центральної частоти"
              selected={deviationMode === 'offset'}
              interactive={!saving}
              onClick={saving ? undefined : () => setDeviationMode('offset')}
            />
          </Box>
        </Box>

        {deviationMode === 'offset' ? (
          <FormControl disabled fullWidth size="small">
            <InputLabel id="network-freq-deviation-select-label" shrink={showDeviationPlaceholder || deviationSelectValue !== ''}>
              Основна частота
            </InputLabel>
            <Select
              labelId="network-freq-deviation-select-label"
              id="network-freq-deviation-select"
              label="Основна частота"
              displayEmpty={showDeviationPlaceholder}
              value={showDeviationPlaceholder ? '' : deviationSelectValue}
              renderValue={
                showDeviationPlaceholder
                  ? () => <Box component="span" sx={(theme) => ({ color: theme.palette.mode === 'light' ? theme.palette.grey[700] : theme.palette.text.secondary })}>Оберіть основну частоту</Box>
                  : undefined
              }
              inputProps={{ name: 'networkFreqDeviationBase' }}
              data-testid="deviation-select"
              sx={compactSelectSx}
            >
              <MenuItem value="" disabled>
                Оберіть основну частоту
              </MenuItem>
              {freq.trim() !== '' ? <MenuItem value={freq.trim()}>{freq.trim()}</MenuItem> : null}
            </Select>
          </FormControl>
        ) : null}
      </Box>
    </Stack>
  );
}
