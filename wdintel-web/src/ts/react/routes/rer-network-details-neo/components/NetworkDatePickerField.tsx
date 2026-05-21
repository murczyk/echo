import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import type { SxProps, Theme } from '@mui/material/styles';
import dayjs from 'dayjs';
import 'dayjs/locale/uk';
import type { Dayjs } from 'dayjs';

dayjs.locale('uk');

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
};

function parseDate(value: string): Dayjs | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const nextValue = dayjs(trimmed);
  return nextValue.isValid() ? nextValue : null;
}

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
}: Props) {
  return (
    <LocalizationProvider
      dateAdapter={AdapterDayjs}
      adapterLocale="uk"
      localeText={{
        cancelButtonLabel: 'Скасувати',
        todayButtonLabel: 'Сьогодні',
        okButtonLabel: 'ОК',
      }}
    >
      <DatePicker
        label={label}
        value={parseDate(value)}
        onChange={(nextValue) => {
          if (nextValue === null) {
            if (allowEmpty) {
              onChange('');
            }
            return;
          }

          if (!nextValue.isValid()) return;

          onChange(nextValue.format('YYYY-MM-DD'));
        }}
        disabled={disabled}
        minDate={minDate}
        maxDate={maxDate}
        format="DD.MM.YYYY"
        slotProps={{
          textField: {
            fullWidth: true,
            size: 'small',
            InputLabelProps: { shrink: true },
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
          openPickerButton: {
            title: 'Відкрити календар',
            'aria-label': 'Відкрити календар',
            sx: { cursor: 'pointer' },
          },
          actionBar: {
            actions: ['today', 'cancel', 'accept'],
          },
        }}
        slots={{
          openPickerIcon: CalendarMonthOutlinedIcon,
        }}
      />
    </LocalizationProvider>
  );
}
