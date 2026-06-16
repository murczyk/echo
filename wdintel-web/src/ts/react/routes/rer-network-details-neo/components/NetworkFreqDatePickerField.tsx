import type { SxProps, Theme } from '@mui/material/styles';
import type { Dayjs } from 'dayjs';
import type { ReactNode } from 'react';

import { NetworkDatePickerField } from './NetworkDatePickerField';

type Props = {
  label: string;
  value: string;
  onChange: (nextValue: string) => void;
  disabled?: boolean;
  minDate?: Dayjs;
  maxDate?: Dayjs;
  textFieldSx?: SxProps<Theme>;
  error?: boolean;
  helperText?: ReactNode;
  onBlur?: () => void;
  required?: boolean;
};

export function NetworkFreqDatePickerField({
  label,
  value,
  onChange,
  disabled = false,
  minDate,
  maxDate,
  textFieldSx,
  error,
  helperText,
  onBlur,
  required,
}: Props) {
  return (
    <NetworkDatePickerField
      label={label}
      value={value}
      onChange={onChange}
      disabled={disabled}
      minDate={minDate}
      maxDate={maxDate}
      textFieldSx={textFieldSx}
      error={error}
      helperText={helperText}
      onBlur={onBlur}
      required={required}
    />
  );
}
