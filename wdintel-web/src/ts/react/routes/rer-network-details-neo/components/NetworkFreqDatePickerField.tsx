import type { Dayjs } from 'dayjs';

import { NetworkDatePickerField } from './NetworkDatePickerField';

type Props = {
  label: string;
  value: string;
  onChange: (nextValue: string) => void;
  disabled?: boolean;
  minDate?: Dayjs;
  maxDate?: Dayjs;
};

export function NetworkFreqDatePickerField({ label, value, onChange, disabled = false, minDate, maxDate }: Props) {
  return <NetworkDatePickerField label={label} value={value} onChange={onChange} disabled={disabled} minDate={minDate} maxDate={maxDate} />;
}
