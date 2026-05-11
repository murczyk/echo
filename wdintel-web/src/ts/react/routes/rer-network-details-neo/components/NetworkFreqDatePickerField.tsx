import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import dayjs from 'dayjs';
import 'dayjs/locale/uk';
import type { Dayjs } from 'dayjs';

dayjs.locale('uk');

type Props = {
  label: string;
  value: string;
  onChange: (nextValue: string) => void;
  disabled?: boolean;
};

function parseDate(value: string): Dayjs | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const nextValue = dayjs(trimmed);
  return nextValue.isValid() ? nextValue : null;
}

export function NetworkFreqDatePickerField({ label, value, onChange, disabled = false }: Props) {
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
        onChange={(nextValue) => onChange(nextValue == null ? '' : nextValue.format('YYYY-MM-DD'))}
        disabled={disabled}
        format="DD.MM.YYYY"
        slotProps={{
          textField: {
            fullWidth: true,
            size: 'small',
            InputLabelProps: { shrink: true },
            sx: {
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
