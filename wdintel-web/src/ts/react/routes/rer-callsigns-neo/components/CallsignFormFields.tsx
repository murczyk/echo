import React from 'react';
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
import { RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR, toUpperCaseCallsign } from '../helpers';
import type { CallsignDraftRow, CallsignEditForm } from '../types';

type CommonFormValue = Pick<CallsignDraftRow, 'callsign' | 'position' | 'fullName' | 'comment' | 'developing' | 'radioFreq'> & {
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
  controlsFirst?: boolean;
  hintContent?: React.ReactNode;
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
  controlsFirst = false,
  hintContent,
}: Props<T>) {
  const spacing = compact ? 1.5 : 2;
  const reactId = React.useId();
  const unitLabelId = `${reactId}-unit-label`;
  const sourceLabelId = `${reactId}-source-label`;
  const confirmationSources = sources.filter((source) => source.id !== value.sourceId);

  const handleSourceChange = (rawValue: string | number) => {
    const nextSourceId = rawValue === '' ? null : Number(rawValue);
    onChange({ ...value, sourceId: nextSourceId });
    if (includeConfirmationSources && onCallsignAdditionalSourceIdsChange) {
      onCallsignAdditionalSourceIdsChange(
        callsignAdditionalSourceIds.filter((sourceId) => sourceId !== nextSourceId),
      );
    }
  };

  const handleConfirmationSourcesChange = (
    rawValue: string | readonly (string | number)[],
  ) => {
    if (!onCallsignAdditionalSourceIdsChange) return;
    onCallsignAdditionalSourceIdsChange(
      typeof rawValue === 'string' ? rawValue.split(',').map(Number) : rawValue.map(Number),
    );
  };

  const renderConfirmationSourcesValue = (selected: readonly (string | number)[]) => {
    const names = selected.map(
      (sourceId) => sources.find((source) => source.id === Number(sourceId))?.name ?? `#${sourceId}`,
    );
    return names.length > 0 ? names.join(', ') : 'Оберіть підтвердження';
  };

  return (
    <Stack spacing={spacing}>
      {controlsFirst && includeUnitSelect ? (
        <Stack direction={{ xs: "column", md: "row" }} spacing={spacing}>
          <FormControl fullWidth size={compact ? "small" : "medium"} disabled={disabled}>
            <InputLabel id={unitLabelId}>Підрозділ</InputLabel>
            <Select labelId={unitLabelId} label="Підрозділ" value={value.unitId ?? ""} onChange={(event) => onChange({ ...value, unitId: Number(event.target.value) || 0 })}>
              {units.map((unit) => (
                <MenuItem key={unit.id} value={unit.id}>
                  {unit.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          {includeSourceSelect ? (
            <FormControl fullWidth size={compact ? "small" : "medium"} disabled={disabled}>
              <InputLabel id={sourceLabelId}>Основне джерело</InputLabel>
              <Select
                labelId={sourceLabelId}
                label="Основне джерело"
                value={value.sourceId ?? ""}
                onChange={(event) => handleSourceChange(event.target.value)}
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
      ) : null}
      {controlsFirst && includeConfirmationSources ? (
        <FormControl fullWidth size={compact ? "small" : "medium"} disabled={disabled}>
          <InputLabel id={sourceLabelId + "-confirm"}>Підтвердження</InputLabel>
          <Select
            labelId={sourceLabelId + "-confirm"}
            label="Підтвердження"
            multiple
            value={callsignAdditionalSourceIds}
            onChange={(event) => handleConfirmationSourcesChange(event.target.value)}
            renderValue={renderConfirmationSourcesValue}
          >
            {confirmationSources.map((source) => (
              <MenuItem key={source.id} value={source.id}>
                {source.name}
              </MenuItem>
            ))}
          </Select>
          <FormHelperText sx={{ ml: 0 }}>Додаткові джерела підтвердження.</FormHelperText>
        </FormControl>
      ) : null}
      {controlsFirst && hintContent ? hintContent : null}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={spacing}>
        <TextField
          label="Позивний"
          value={value.callsign}
          onChange={(event) => onChange({ ...value, callsign: toUpperCaseCallsign(event.target.value) })}
          disabled={disabled}
          fullWidth
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
        label="ПІП"
        value={value.fullName}
        onChange={(event) => onChange({ ...value, fullName: event.target.value })}
        disabled={disabled}
        fullWidth
        size={compact ? 'small' : 'medium'}
      />

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
        <FormControl fullWidth size={compact ? 'small' : 'medium'}>
          <TextField
            label="Частота"
            value={value.radioFreq}
            onChange={(event) => onChange({ ...value, radioFreq: event.target.value })}
            disabled={disabled}
            fullWidth
            size={compact ? 'small' : 'medium'}
            placeholder="Напр. 145.500"
          />
          {value.sourceId === 2 ? (
            <FormHelperText sx={{ ml: 0 }}>{RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR}</FormHelperText>
          ) : null}
        </FormControl>
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

      {!controlsFirst && includeUnitSelect ? (
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

      {!controlsFirst && includeSourceSelect ? (
        <FormControl fullWidth size={compact ? 'small' : 'medium'} disabled={disabled}>
          <InputLabel id={sourceLabelId}>Основне джерело</InputLabel>
          <Select
            labelId={sourceLabelId}
            label="Основне джерело"
            value={value.sourceId ?? ''}
            onChange={(event) => handleSourceChange(event.target.value)}
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

      {!controlsFirst && includeConfirmationSources ? (
        <FormControl fullWidth size={compact ? 'small' : 'medium'} disabled={disabled}>
          <InputLabel id={`${sourceLabelId}-confirm`}>Підтвердження</InputLabel>
          <Select
            labelId={`${sourceLabelId}-confirm`}
            label="Підтвердження"
            multiple
            value={callsignAdditionalSourceIds}
            onChange={(event) => handleConfirmationSourcesChange(event.target.value)}
            renderValue={renderConfirmationSourcesValue}
          >
            {confirmationSources.map((source) => (
              <MenuItem key={source.id} value={source.id}>
                {source.name}
              </MenuItem>
            ))}
          </Select>
          <FormHelperText sx={{ ml: 0 }}>Додаткові джерела підтвердження.</FormHelperText>
        </FormControl>
      ) : null}
    </Stack>
  );
}

export type { CallsignEditForm };
