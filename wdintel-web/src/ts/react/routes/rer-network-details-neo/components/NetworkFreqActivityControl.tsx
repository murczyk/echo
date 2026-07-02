import { FormControlLabel, Stack, Switch } from '@mui/material';

import { NetworkFreqDatePickerField } from './NetworkFreqDatePickerField';
import { formatUtcDateInputValue } from '../../../utils/misc';

type Props = {
  activeTo: string;
  onChange: (nextValue: string) => void;
  disabled?: boolean;
};

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

              onChange(activeTo.trim() === '' ? formatUtcDateInputValue(new Date()) : activeTo);
            }}
          />
        }
        label="Активна досі"
        disabled={disabled}
      />

      {!isActiveStill ? (
        <NetworkFreqDatePickerField
          label="Активна по"
          value={activeTo}
          onChange={onChange}
          disabled={disabled}
        />
      ) : null}
    </Stack>
  );
}
