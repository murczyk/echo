import { useId } from 'react';
import {
  Checkbox,
  FormControl,
  FormHelperText,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
} from '@mui/material';

import type { Source, Unit } from '../../../../../Bindings';
import { toUpperCaseCallsign } from '../helpers';
import type { CallsignDraftRow, CallsignEditForm } from '../types';

type CommonFormValue = Pick<CallsignDraftRow, 'callsign' | 'position' | 'comment' | 'developing' | 'radioFreq'> & {
  unitId?: number;
  sourceId?: number | null;
};

type Props<T extends CommonFormValue> = {
  value: T;
  onChange: (next: T) => void;
  units?: Unit[];
  sources?: Source[];
  includeUnitSelect?: boolean;
  includeSourceSelect?: boolean;
  includeConfirmationSources?: boolean;
  callsignAdditionalSourceIds?: number[];
  onCallsignAdditionalSourceIdsChange?: (sourceIds: number[]) => void;
  disabled?: boolean;
  compact?: boolean;
};

export function CallsignFormFields<T extends CommonFormValue>({
  value,
  onChange,
  units = [],
  sources = [],
  includeUnitSelect = false,
  includeSourceSelect = false,
  includeConfirmationSources = false,
  callsignAdditionalSourceIds = [],
  onCallsignAdditionalSourceIdsChange,
  disabled = false,
  compact = false,
}: Props<T>) {
  const spacing = compact ? 1.5 : 2;
  const reactId = useId();
  const unitLabelId = `${reactId}-unit-label`;
  const sourceLabelId = `${reactId}-source-label`;
  const confirmationSources = sources.filter((source) => source.id !== value.sourceId);

  return (
    <Stack spacing={spacing}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={spacing}>
        <TextField
          label="Позивний"
          value={value.callsign}
          onChange={(event) => onChange({ ...value, callsign: toUpperCaseCallsign(event.target.value) })}
          disabled={disabled}
          fullWidth
          required
          size={compact ? 'small' : 'medium'}
        />
        <TextField
          label="Посада"
          value={value.position}
          onChange={(event) => onChange({ ...value, position: event.target.value })}
          disabled={disabled}
          fullWidth
          size={compact ? 'small' : 'medium'}
        />
      </Stack>

      <TextField
        label="Коментар"
        value={value.comment}
        onChange={(event) => onChange({ ...value, comment: event.target.value })}
        disabled={disabled}
        fullWidth
        multiline
        minRows={compact ? 1 : 2}
        size={compact ? 'small' : 'medium'}
      />

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={spacing} alignItems={{ md: 'center' }}>
        <TextField
          label="Частота"
          value={value.radioFreq}
          onChange={(event) => onChange({ ...value, radioFreq: event.target.value })}
          disabled={disabled}
          fullWidth
          size={compact ? 'small' : 'medium'}
          placeholder="Напр. 145.500"
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={value.developing}
              onChange={(event) => onChange({ ...value, developing: event.target.checked })}
              disabled={disabled}
              size={compact ? 'small' : 'medium'}
            />
          }
          label="В дорозвідці"
          sx={{ whiteSpace: 'nowrap', ml: { md: 0.5 } }}
        />
      </Stack>

      {includeUnitSelect ? (
        <FormControl fullWidth size={compact ? 'small' : 'medium'} disabled={disabled}>
          <InputLabel id={unitLabelId}>Підрозділ</InputLabel>
          <Select
            labelId={unitLabelId}
            label="Підрозділ"
            value={value.unitId ?? ''}
            onChange={(event) => onChange({ ...value, unitId: Number(event.target.value) || 0 })}
          >
            {units.map((unit) => (
              <MenuItem key={unit.id} value={unit.id}>
                {unit.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      ) : null}

      {includeSourceSelect ? (
        <FormControl fullWidth size={compact ? 'small' : 'medium'} disabled={disabled}>
          <InputLabel id={sourceLabelId}>Основне джерело</InputLabel>
          <Select
            labelId={sourceLabelId}
            label="Основне джерело"
            value={value.sourceId ?? ''}
            onChange={(event) => {
              const raw = event.target.value;
              const nextSourceId = raw === '' ? null : Number(raw);
              onChange({ ...value, sourceId: nextSourceId });
              if (includeConfirmationSources && onCallsignAdditionalSourceIdsChange) {
                onCallsignAdditionalSourceIdsChange(callsignAdditionalSourceIds.filter((sourceId) => sourceId !== nextSourceId));
              }
            }}
          >
            <MenuItem value="">
              <em>Оберіть джерело</em>
            </MenuItem>
            {sources.map((source) => (
              <MenuItem key={source.id} value={source.id}>
                {source.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      ) : null}

      {includeConfirmationSources ? (
        <FormControl fullWidth size={compact ? 'small' : 'medium'} disabled={disabled}>
          <InputLabel id={`${sourceLabelId}-confirm`}>Підтвердження</InputLabel>
          <Select
            labelId={`${sourceLabelId}-confirm`}
            label="Підтвердження"
            multiple
            value={callsignAdditionalSourceIds}
            onChange={(event) => {
              if (!onCallsignAdditionalSourceIdsChange) return;
              const raw = event.target.value;
              onCallsignAdditionalSourceIdsChange(typeof raw === 'string' ? raw.split(',').map(Number) : raw.map(Number));
            }}
            renderValue={(selected) => {
              const names = selected
                .map((sourceId) => sources.find((source) => source.id === Number(sourceId))?.name ?? `#${sourceId}`);
              return names.length > 0 ? names.join(', ') : 'Оберіть підтвердження';
            }}
          >
            {confirmationSources.map((source) => (
              <MenuItem key={source.id} value={source.id}>
                {source.name}
              </MenuItem>
            ))}
          </Select>
          <FormHelperText>Додаткові джерела підтвердження.</FormHelperText>
        </FormControl>
      ) : null}
    </Stack>
  );
}

export type { CallsignEditForm };
