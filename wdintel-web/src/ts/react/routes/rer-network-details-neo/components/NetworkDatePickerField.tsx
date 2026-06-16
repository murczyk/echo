import type { SxProps, Theme } from '@mui/material/styles';
import type { Dayjs } from 'dayjs';
import type { ReactNode } from 'react';
import { PowerDatePicker } from '../../../components/PowerDateTimePicker';

import { formatNetworkDateValue, parseNetworkDateValue } from './network-date-picker.utils';

type Props = {
  label: string;
  value: string;
  onChange: (nextValue: string) => void;
  disabled?: boolean;
  minDate?: Dayjs;
  maxDate?: Dayjs;
  allowEmpty?: boolean;
  width?: number | string;
  textFieldSx?: SxProps<Theme>;
  error?: boolean;
  helperText?: ReactNode;
  onBlur?: () => void;
  required?: boolean;
};

export function NetworkDatePickerField({
  label,
  value,
  onChange,
  disabled = false,
  minDate,
  maxDate,
  allowEmpty = true,
  width = 162,
  textFieldSx,
  error,
  helperText,
  onBlur,
  required,
}: Props) {
  return (
    <PowerDatePicker
      label={label}
      value={parseNetworkDateValue(value)}
      allowEmpty={allowEmpty}
      onChange={(nextValue) => {
        if (nextValue === null) {
          if (allowEmpty) onChange('');
          return;
        }

        onChange(formatNetworkDateValue(nextValue));
      }}
      disabled={disabled}
      minDate={minDate}
      maxDate={maxDate}
      format="DD.MM.YYYY"
      slotProps={{
        textField: {
          fullWidth: true,
          size: 'small',
          error,
          helperText,
          required,
          InputLabelProps: { shrink: true },
          onBlur,
          sx: {
            width,
            cursor: 'pointer',
            '& .MuiOutlinedInput-root': {
              height: 40,
              minHeight: 40,
              cursor: 'pointer',
              backgroundColor: 'transparent',
              '& input': {
                cursor: 'pointer',
                fontSize: '0.875rem',
              },
            },
            ...textFieldSx,
          },
        },
      }}
    />
  );
}
