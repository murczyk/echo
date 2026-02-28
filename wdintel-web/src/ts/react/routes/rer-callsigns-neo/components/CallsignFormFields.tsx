import React from 'react';
import {
  Checkbox,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
} from '@mui/material';

import type { Source, Unit } from '../../../../../Bindings';
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
  disabled = false,
  compact = false,
}: Props<T>) {
  const spacing = compact ? 1.5 : 2;
  const reactId = React.useId();
  const unitLabelId = `${reactId}-unit-label`;
  const sourceLabelId = `${reactId}-source-label`;

  return (
    <Stack spacing={spacing}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={spacing}>
        <TextField
          label="Позивний"
          value={value.callsign}
          onChange={(event) => onChange({ ...value, callsign: event.target.value })}
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
          <InputLabel id={sourceLabelId}>Джерело</InputLabel>
          <Select
            labelId={sourceLabelId}
            label="Джерело"
            value={value.sourceId ?? ''}
            onChange={(event) => {
              const raw = event.target.value;
              onChange({ ...value, sourceId: raw === '' ? null : Number(raw) });
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
    </Stack>
  );
}

export type { CallsignEditForm };
