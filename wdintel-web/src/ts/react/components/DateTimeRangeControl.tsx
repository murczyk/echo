import { Box, Button, Paper, Popover, Stack, TextField } from '@mui/material';
import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import dayjs from 'dayjs';
import 'dayjs/locale/uk';
import type { Dayjs } from 'dayjs';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';

dayjs.locale('uk');

import { APP_DATETIME_INPUT_MIN, APP_TIME_ZONE } from '../utils/misc';
import { CompactTitle } from './CompactTypography';

export type DateTimeRangeValue = {
  fromDateTimeStr: string;
  toDateTimeStr: string;
};

export type DateTimeRangeControlProps = {
  value: DateTimeRangeValue;
  onChange: (value: DateTimeRangeValue) => void;
  className?: string;
  disabled?: boolean;
};

function formatDisplayValue(value: string): string {
  if (!value) return '—';
  const [datePart = '', timePart = ''] = value.split('T');
  if (datePart === '' || timePart === '') return value;
  const [year = '', month = '', day = ''] = datePart.split('-');
  if (year === '' || month === '' || day === '') return value;
  return `${day}.${month}.${year} ${timePart}`;
}

function parseDateTimeInAppTimeZone(value: string): Dayjs | null {
  if (!value) return null;
  return dayjs.tz(value, APP_TIME_ZONE) as Dayjs;
}

function formatDateTimeInAppTimeZone(value: Dayjs | null): string {
  if (!value) return '';
  return (value as Dayjs).tz(APP_TIME_ZONE, true).format('YYYY-MM-DDTHH:mm');
}

export function DateTimeRangeControl({ value, onChange, className, disabled = false }: DateTimeRangeControlProps) {
  const anchorId = useId().replace(/:/g, '-');
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [activePreset, setActivePreset] = useState<'custom' | 1 | 3 | 7 | 14 | 30>('custom');
  const [draftValue, setDraftValue] = useState(value);
  const open = Boolean(anchorEl);

  useEffect(() => {
    if (open) return;
    setDraftValue(value);
  }, [open, value]);

  const applyPreset = useCallback(
    (days: 1 | 3 | 7 | 14 | 30) => {
      const to = dayjs().tz(APP_TIME_ZONE);
      const from = to.subtract(days, 'day');
      setActivePreset(days);
      onChange({
        fromDateTimeStr: from.format('YYYY-MM-DDTHH:mm'),
        toDateTimeStr: to.format('YYYY-MM-DDTHH:mm'),
      });
      setAnchorEl(null);
    },
    [onChange],
  );

  const openPopover = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }
      setDraftValue(value);
      setAnchorEl(event.currentTarget);
    },
    [value],
  );

  const closePopover = useCallback(() => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    window.requestAnimationFrame(() => {
      setAnchorEl(null);
    });
  }, []);

  const intervalLabel = useMemo(
    () => `${formatDisplayValue(value.fromDateTimeStr)} — ${formatDisplayValue(value.toDateTimeStr)}`,
    [value.fromDateTimeStr, value.toDateTimeStr],
  );

  return (
    <Stack className={className} direction="row" spacing={0} sx={{ minWidth: 0, width: '100%' }}>
      <TextField
        id={anchorId}
        value={intervalLabel}
        onMouseDown={(event) => event.preventDefault()}
        onClick={openPopover}
        aria-haspopup="dialog"
        aria-expanded={open ? 'true' : 'false'}
        disabled={disabled}
        fullWidth
        size="small"
        placeholder="Інтервал"
        inputProps={{
          readOnly: true,
        }}
        InputProps={{
          endAdornment: (
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', mx: 1.5, color: 'primary.main' }}>
              <CalendarMonthOutlinedIcon sx={{ fontSize: 16 }} />
            </Box>
          ),
        }}
        sx={{
          width: '100%',
          minWidth: 0,
          '& .MuiOutlinedInput-root': {
            height: 40,
            minHeight: 40,
            cursor: 'pointer',
            backgroundColor: 'transparent',
            paddingRight: 0,
            px: 0,
            '& fieldset': {
              borderColor: 'divider',
            },
            '&:hover fieldset': {
              borderColor: 'text.secondary',
            },
            '&.Mui-focused fieldset': {
              borderColor: 'primary.main',
            },
          },
          '& .MuiInputBase-input': {
            cursor: 'pointer',
            fontSize: '0.875rem',
            fontWeight: 400,
            color: 'text.primary',
            py: 0,
            pl: 1.5,
            pr: 0,
          },
        }}
      />
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={closePopover}
        disableAutoFocus
        disableEnforceFocus
        disableRestoreFocus
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        PaperProps={{
          sx: {
            width: { xs: 'calc(100vw - 24px)', md: 720 },
            maxWidth: 'calc(100vw - 24px)',
            p: 1.5,
            mt: 1,
          },
        }}
      >
        <LocalizationProvider
          dateAdapter={AdapterDayjs}
          adapterLocale="uk"
          localeText={{
            cancelButtonLabel: 'Скасувати',
            todayButtonLabel: 'Сьогодні',
            okButtonLabel: 'ОК',
          }}
        >
          <Stack spacing={1.5}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
              <CompactTitle component="strong">Інтервал</CompactTitle>
              <Button size="small" onClick={closePopover}>
                Закрити
              </Button>
            </Stack>
            <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
              {([1, 3, 7, 14, 30] as const).map((days) => (
                <Button
                  key={days}
                  size="small"
                  variant={activePreset === days ? 'contained' : 'outlined'}
                  onClick={() => applyPreset(days)}
                  disabled={disabled}
                  sx={{ minWidth: 0, flexShrink: 0 }}
                >
                  {days} дн
                </Button>
              ))}
            </Stack>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              <Paper variant="outlined" sx={{ flex: 1, p: 1.25 }}>
                <Stack spacing={1.25}>
                  <CompactTitle component="div">Від</CompactTitle>
                  <DateTimePicker
                    value={parseDateTimeInAppTimeZone(draftValue.fromDateTimeStr)}
                    onChange={(nextValue) => {
                      const fromDateTimeStr = formatDateTimeInAppTimeZone(nextValue);
                      setActivePreset('custom');
                      setDraftValue((current) => ({ ...current, fromDateTimeStr }));
                    }}
                    onAccept={(nextValue) => {
                      const fromDateTimeStr = formatDateTimeInAppTimeZone(nextValue);
                      const nextRange = { ...draftValue, fromDateTimeStr };
                      setActivePreset('custom');
                      setDraftValue(nextRange);
                      onChange(nextRange);
                    }}
                    minDateTime={dayjs.tz(APP_DATETIME_INPUT_MIN, APP_TIME_ZONE) as Dayjs}
                    format="DD.MM.YYYY HH:mm"
                    ampm={false}
                    slotProps={{
                      textField: {
                        size: 'small',
                        fullWidth: true,
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
                </Stack>
              </Paper>
              <Paper variant="outlined" sx={{ flex: 1, p: 1.25 }}>
                <Stack spacing={1.25}>
                  <CompactTitle component="div">До</CompactTitle>
                  <DateTimePicker
                    value={parseDateTimeInAppTimeZone(draftValue.toDateTimeStr)}
                    onChange={(nextValue) => {
                      const toDateTimeStr = formatDateTimeInAppTimeZone(nextValue);
                      setActivePreset('custom');
                      setDraftValue((current) => ({ ...current, toDateTimeStr }));
                    }}
                    onAccept={(nextValue) => {
                      const toDateTimeStr = formatDateTimeInAppTimeZone(nextValue);
                      const nextRange = { ...draftValue, toDateTimeStr };
                      setActivePreset('custom');
                      setDraftValue(nextRange);
                      onChange(nextRange);
                    }}
                    minDateTime={dayjs.tz(APP_DATETIME_INPUT_MIN, APP_TIME_ZONE) as Dayjs}
                    format="DD.MM.YYYY HH:mm"
                    ampm={false}
                    slotProps={{
                      textField: {
                        size: 'small',
                        fullWidth: true,
                        InputLabelProps: { shrink: true },
                        sx: {
                          '& .MuiOutlinedInput-root': {
                            height: 40,
                            minHeight: 40,
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
                </Stack>
              </Paper>
            </Stack>
          </Stack>
        </LocalizationProvider>
      </Popover>
    </Stack>
  );
}
