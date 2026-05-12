import { FormControlLabel, Stack, Switch } from '@mui/material';

import { NetworkFreqDatePickerField } from './NetworkFreqDatePickerField';

type Props = {
  activeTo: string;
  onChange: (nextValue: string) => void;
  disabled?: boolean;
};

function toDateInputValue(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function NetworkFreqActivityControl({ activeTo, onChange, disabled = false }: Props) {
  const isActiveStill = activeTo.trim() === '';

  return (
    <Stack spacing={0.75}>
      <FormControlLabel
        sx={{ m: 0, width: 'fit-content', alignSelf: 'flex-start' }}
        control={
          <Switch
            checked={isActiveStill}
            onChange={(_event, checked) => {
              if (checked) {
                onChange('');
                return;
              }

              onChange(activeTo.trim() === '' ? toDateInputValue(new Date()) : activeTo);
            }}
          />
        }
        label="Активна досі"
        disabled={disabled}
      />

      {!isActiveStill ? (
        <NetworkFreqDatePickerField label="Активна по" value={activeTo} onChange={onChange} disabled={disabled} />
      ) : null}
    </Stack>
  );
}
