import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import { Box, Button, Paper, Popover, Stack, TextField } from '@mui/material';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';

import { APP_DATETIME_INPUT_MIN, APP_TIME_ZONE } from '../utils/misc';
import { CompactTitle } from './CompactTypography';
import { PowerDateTimePicker } from './PowerDateTimePicker';

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

export function getDateTimeRangeControlTextFieldSx(open: boolean) {
  return {
    width: '100%',
    minWidth: 0,
    '& .MuiOutlinedInput-root': {
      height: 40,
      minHeight: 40,
      cursor: 'pointer',
      backgroundColor: 'transparent',
      paddingRight: 0,
      px: 0,
      ...(open
        ? {
            '& fieldset': {
              borderColor: 'primary.main',
            },
            '&:hover fieldset': {
              borderColor: 'primary.main',
            },
          }
        : {}),
      '&.Mui-focused fieldset': {
        borderColor: 'primary.main',
        borderWidth: 1,
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
  };
}

export function DateTimeRangeControl({ value, onChange, className, disabled = false }: DateTimeRangeControlProps) {
  const anchorId = useId().replace(/:/g, '-');
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [activePreset, setActivePreset] = useState<'custom' | 1 | 3 | 7 | 14 | 30>('custom');
  const valueRef = useRef(value);
  const open = Boolean(anchorEl);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const applyPreset = useCallback(
    (days: 1 | 3 | 7 | 14 | 30) => {
      const to = dayjs().tz(APP_TIME_ZONE);
      const from = to.subtract(days, 'day');
      const nextValue = {
        fromDateTimeStr: from.format('YYYY-MM-DDTHH:mm'),
        toDateTimeStr: to.format('YYYY-MM-DDTHH:mm'),
      };
      setActivePreset(days);
      valueRef.current = nextValue;
      onChange(nextValue);
      setAnchorEl(null);
    },
    [onChange],
  );

  const openPopover = useCallback((event: MouseEvent<HTMLElement>) => {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    setAnchorEl(event.currentTarget);
  }, []);

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
        sx={getDateTimeRangeControlTextFieldSx(open)}
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
                <PowerDateTimePicker
                  value={parseDateTimeInAppTimeZone(value.fromDateTimeStr)}
                  allowEmpty={false}
                  onChange={(nextValue) => {
                    const nextRange = {
                      ...valueRef.current,
                      fromDateTimeStr: formatDateTimeInAppTimeZone(nextValue),
                    };
                    setActivePreset('custom');
                    valueRef.current = nextRange;
                    onChange(nextRange);
                  }}
                  minDateTime={dayjs.tz(APP_DATETIME_INPUT_MIN, APP_TIME_ZONE) as Dayjs}
                  format="DD.MM.YYYY HH:mm"
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
                  }}
                />
              </Stack>
            </Paper>
            <Paper variant="outlined" sx={{ flex: 1, p: 1.25 }}>
              <Stack spacing={1.25}>
                <CompactTitle component="div">До</CompactTitle>
                <PowerDateTimePicker
                  value={parseDateTimeInAppTimeZone(value.toDateTimeStr)}
                  allowEmpty={false}
                  onChange={(nextValue) => {
                    const nextRange = {
                      ...valueRef.current,
                      toDateTimeStr: formatDateTimeInAppTimeZone(nextValue),
                    };
                    setActivePreset('custom');
                    valueRef.current = nextRange;
                    onChange(nextRange);
                  }}
                  minDateTime={dayjs.tz(APP_DATETIME_INPUT_MIN, APP_TIME_ZONE) as Dayjs}
                  format="DD.MM.YYYY HH:mm"
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
                  }}
                />
              </Stack>
            </Paper>
          </Stack>
        </Stack>
      </Popover>
    </Stack>
  );
}
