import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import { Button, DialogActions } from '@mui/material';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import type { PickersActionBarProps } from '@mui/x-date-pickers/PickersActionBar';
import { usePickersTranslations } from '@mui/x-date-pickers/hooks/usePickersTranslations';
import dayjs from 'dayjs';
import 'dayjs/locale/uk';
import type { Dayjs } from 'dayjs';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';

dayjs.locale('uk');

function isValidPickerValue(value: Dayjs | null): boolean {
  return value != null && value.isValid();
}

function buildDesktopModeProps() {
  return {
    desktopModeMediaQuery: '@media all',
    slots: {
      openPickerIcon: CalendarMonthOutlinedIcon,
    },
    slotProps: {
      openPickerButton: {
        title: 'Відкрити календар',
        'aria-label': 'Відкрити календар',
        sx: { cursor: 'pointer' },
      },
    },
  };
}

type PowerPickerActionBarProps = PickersActionBarProps & {
  onRequestClose?: () => void;
  powerActions?: Array<'clear' | 'today' | 'accept' | 'close'>;
};

export function PowerPickerActionBar({
  className,
  powerActions = [],
  onAccept,
  onClear,
  onSetToday,
  onRequestClose,
}: PowerPickerActionBarProps) {
  const translations = usePickersTranslations();

  if (powerActions.length === 0) {
    return null;
  }

  return (
    <DialogActions
      className={className}
      sx={{
        px: 1.5,
        py: 1.5,
        justifyContent: 'flex-end',
        gap: 1.5,
        borderTop: 1,
        borderColor: 'divider',
      }}
    >
      {powerActions.map((actionType) => {
        switch (actionType) {
          case 'clear':
            return (
              <Button key={actionType} onClick={onClear}>
                {translations.clearButtonLabel}
              </Button>
            );
          case 'accept':
            return (
              <Button key={actionType} variant="contained" onClick={onAccept}>
                {translations.okButtonLabel}
              </Button>
            );
          case 'today':
            return (
              <Button key={actionType} onClick={onSetToday}>
                {translations.todayButtonLabel}
              </Button>
            );
          case 'close':
            return (
              <Button key={actionType} onClick={() => onRequestClose?.()}>
                Закрити
              </Button>
            );
          default:
            return null;
        }
      })}
    </DialogActions>
  );
}

type BaseDatePickerProps = ComponentProps<typeof DatePicker>;

type PowerDatePickerProps = Omit<
  BaseDatePickerProps,
  'value' | 'onChange' | 'desktopModeMediaQuery' | 'slots' | 'slotProps'
> & {
  value: Dayjs | null;
  onChange: (nextValue: Dayjs | null) => void;
  allowEmpty?: boolean;
  manualInputDebounceMs?: number;
  slotProps?: BaseDatePickerProps['slotProps'];
};

export function PowerDatePicker({
  onChange,
  allowEmpty = false,
  manualInputDebounceMs = 250,
  slotProps,
  ...props
}: PowerDatePickerProps) {
  const desktopModeProps = buildDesktopModeProps();
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState<Dayjs | null>(props.value);
  const debounceTimerRef = useRef<number | null>(null);
  const pendingValueRef = useRef<Dayjs | null>(null);
  const acceptingRef = useRef(false);
  const selectedSectionsRef = useRef<BaseDatePickerProps['selectedSections']>(
    props.selectedSections ?? null,
  );

  useEffect(() => {
    selectedSectionsRef.current = props.selectedSections ?? null;
  }, [props.selectedSections]);

  useEffect(
    () => () => {
      if (debounceTimerRef.current != null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      pendingValueRef.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    if (props.value != null) return;
    clearPendingChange();
  }, [props.value]);

  useEffect(() => {
    setDraftValue(props.value);
  }, [props.value]);

  const isManualFieldEdit = () => selectedSectionsRef.current != null;

  const clearPendingChange = () => {
    if (debounceTimerRef.current != null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingValueRef.current = null;
  };

  const flushPendingChange = () => {
    if (debounceTimerRef.current == null || pendingValueRef.current == null) return;

    window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
    const pendingValue = pendingValueRef.current;
    pendingValueRef.current = null;
    onChange(pendingValue);
  };

  const scheduleManualChange = (value: Dayjs) => {
    clearPendingChange();
    pendingValueRef.current = value;
    debounceTimerRef.current = window.setTimeout(() => {
      const pendingValue = pendingValueRef.current;
      debounceTimerRef.current = null;
      pendingValueRef.current = null;
      if (pendingValue != null) {
        onChange(pendingValue);
      }
    }, manualInputDebounceMs);
  };

  const handleOpen = () => {
    const pendingValue = pendingValueRef.current;
    flushPendingChange();
    setDraftValue(pendingValue ?? props.value);
    setOpen(true);
    props.onOpen?.();
  };

  const handleClose = () => {
    setOpen(false);
    if (!acceptingRef.current) {
      setDraftValue(props.value);
    }
    acceptingRef.current = false;
    props.onClose?.();
  };

  const handleAccept = () => {
    acceptingRef.current = true;
    clearPendingChange();
    const nextValue = draftValue;
    setOpen(false);
    if (nextValue == null) {
      if (allowEmpty) onChange(null);
      return;
    }
    if (!isValidPickerValue(nextValue)) return;
    onChange(nextValue);
    props.onAccept?.(nextValue as never, { validationError: null } as never);
  };

  return (
    <LocalizationProvider
      dateAdapter={AdapterDayjs}
      adapterLocale="uk"
      localeText={{
        cancelButtonLabel: 'Закрити',
        todayButtonLabel: 'Сьогодні',
        okButtonLabel: 'ОК',
      }}
    >
      <DatePicker
        {...props}
        {...desktopModeProps}
        value={draftValue}
        open={open}
        closeOnSelect={false}
        onOpen={handleOpen}
        onClose={handleClose}
        onAccept={handleAccept}
        onSelectedSectionsChange={(nextSelectedSections) => {
          selectedSectionsRef.current = nextSelectedSections;
          props.onSelectedSectionsChange?.(nextSelectedSections);
        }}
        onChange={(value, context) => {
          if (context.validationError != null) return;
          if (value == null) {
            clearPendingChange();
            setDraftValue(null);
            if (allowEmpty) onChange(null);
            return;
          }
          if (!isValidPickerValue(value)) return;
          if (isManualFieldEdit()) {
            setDraftValue(value);
            scheduleManualChange(value);
            return;
          }
          if (open) {
            setDraftValue(value);
            return;
          }
          setDraftValue(value);
          onChange(value);
        }}
        slots={{
          ...desktopModeProps.slots,
          actionBar: PowerPickerActionBar,
        }}
        slotProps={{
          ...desktopModeProps.slotProps,
          ...slotProps,
          actionBar: {
            ...(slotProps?.actionBar ?? {}),
            actions: [] as Array<'clear' | 'cancel' | 'accept' | 'today'>,
            powerActions: ['close', 'accept'],
            onRequestClose: handleClose,
          } as any,
        }}
      />
    </LocalizationProvider>
  );
}

type BaseDateTimePickerProps = ComponentProps<typeof DateTimePicker>;

type PowerDateTimePickerProps = Omit<
  BaseDateTimePickerProps,
  'value' | 'onChange' | 'desktopModeMediaQuery' | 'slots' | 'slotProps'
> & {
  value: Dayjs | null;
  onChange: (nextValue: Dayjs | null) => void;
  allowEmpty?: boolean;
  manualInputDebounceMs?: number;
  slotProps?: BaseDateTimePickerProps['slotProps'];
};

export function PowerDateTimePicker({
  onChange,
  allowEmpty = false,
  manualInputDebounceMs = 250,
  slotProps,
  ...props
}: PowerDateTimePickerProps) {
  const desktopModeProps = buildDesktopModeProps();
  const [open, setOpen] = useState(false);
  const [draftValue, setDraftValue] = useState<Dayjs | null>(props.value);
  const debounceTimerRef = useRef<number | null>(null);
  const pendingValueRef = useRef<Dayjs | null>(null);
  const acceptingRef = useRef(false);
  const selectedSectionsRef = useRef<BaseDateTimePickerProps['selectedSections']>(
    props.selectedSections ?? null,
  );

  useEffect(() => {
    selectedSectionsRef.current = props.selectedSections ?? null;
  }, [props.selectedSections]);

  useEffect(
    () => () => {
      if (debounceTimerRef.current != null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      pendingValueRef.current = null;
    },
    [],
  );

  useLayoutEffect(() => {
    if (props.value != null) return;
    clearPendingChange();
  }, [props.value]);

  useEffect(() => {
    setDraftValue(props.value);
  }, [props.value]);

  const isManualFieldEdit = () => selectedSectionsRef.current != null;

  const clearPendingChange = () => {
    if (debounceTimerRef.current != null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    pendingValueRef.current = null;
  };

  const flushPendingChange = () => {
    if (debounceTimerRef.current == null || pendingValueRef.current == null) return;

    window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
    const pendingValue = pendingValueRef.current;
    pendingValueRef.current = null;
    onChange(pendingValue);
  };

  const scheduleManualChange = (value: Dayjs) => {
    clearPendingChange();
    pendingValueRef.current = value;
    debounceTimerRef.current = window.setTimeout(() => {
      const pendingValue = pendingValueRef.current;
      debounceTimerRef.current = null;
      pendingValueRef.current = null;
      if (pendingValue != null) {
        onChange(pendingValue);
      }
    }, manualInputDebounceMs);
  };

  const handleOpen = () => {
    const pendingValue = pendingValueRef.current;
    flushPendingChange();
    setDraftValue(pendingValue ?? props.value);
    setOpen(true);
    props.onOpen?.();
  };

  const handleClose = () => {
    setOpen(false);
    if (!acceptingRef.current) {
      setDraftValue(props.value);
    }
    acceptingRef.current = false;
    props.onClose?.();
  };

  const handleAccept = () => {
    acceptingRef.current = true;
    clearPendingChange();
    const nextValue = draftValue;
    setOpen(false);
    if (nextValue == null) {
      if (allowEmpty) onChange(null);
      return;
    }
    if (!isValidPickerValue(nextValue)) return;
    onChange(nextValue);
    props.onAccept?.(nextValue as never, { validationError: null } as never);
  };

  const handleChange = (value: Dayjs | null, context: { validationError: unknown }) => {
    if (context.validationError != null) return;
    if (value == null) {
      clearPendingChange();
      setDraftValue(null);
      if (allowEmpty) onChange(null);
      return;
    }
    if (!isValidPickerValue(value)) return;
    if (isManualFieldEdit()) {
      setDraftValue(value);
      scheduleManualChange(value);
      return;
    }
    if (open) {
      setDraftValue(value);
      return;
    }
    setDraftValue(value);
    onChange(value);
  };

  return (
    <LocalizationProvider
      dateAdapter={AdapterDayjs}
      adapterLocale="uk"
      localeText={{
        cancelButtonLabel: 'Закрити',
        todayButtonLabel: 'Сьогодні',
        okButtonLabel: 'ОК',
      }}
    >
      <DateTimePicker
        {...props}
        {...desktopModeProps}
        value={draftValue}
        open={open}
        closeOnSelect={false}
        ampm={false}
        onOpen={handleOpen}
        onClose={handleClose}
        onAccept={handleAccept}
        onSelectedSectionsChange={(nextSelectedSections) => {
          selectedSectionsRef.current = nextSelectedSections;
          props.onSelectedSectionsChange?.(nextSelectedSections);
        }}
        onChange={handleChange}
        slots={{
          ...desktopModeProps.slots,
          actionBar: PowerPickerActionBar,
        }}
        slotProps={{
          ...desktopModeProps.slotProps,
          ...slotProps,
          actionBar: {
            ...(slotProps?.actionBar ?? {}),
            actions: [] as Array<'clear' | 'cancel' | 'accept' | 'today'>,
            powerActions: ['close', 'accept'],
            onRequestClose: handleClose,
          } as any,
        }}
      />
    </LocalizationProvider>
  );
}
