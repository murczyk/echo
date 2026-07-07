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
import type { ComponentProps } from 'react';

import { usePowerDatePickerDraft } from './usePowerDatePickerDraft';

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
  const pickerDraft = usePowerDatePickerDraft<Dayjs | null>({
    value: props.value,
    allowEmpty,
    manualInputDebounceMs,
    selectedSections: props.selectedSections ?? null,
    onChange,
    onAccept: (nextValue) =>
      props.onAccept?.(nextValue as never, { validationError: null } as never),
    onOpen: props.onOpen,
    onClose: props.onClose,
    isValidValue: isValidPickerValue,
  });

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
        value={pickerDraft.draftValue}
        open={pickerDraft.open}
        closeOnSelect={false}
        onOpen={pickerDraft.handleOpen}
        onClose={pickerDraft.handleClose}
        onAccept={pickerDraft.handleAccept}
        onSelectedSectionsChange={(nextSelectedSections) => {
          pickerDraft.handleSelectedSectionsChange(nextSelectedSections);
          props.onSelectedSectionsChange?.(nextSelectedSections);
        }}
        onChange={pickerDraft.handleChange}
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
            onRequestClose: pickerDraft.handleClose,
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
  const pickerDraft = usePowerDatePickerDraft<Dayjs | null>({
    value: props.value,
    allowEmpty,
    manualInputDebounceMs,
    selectedSections: props.selectedSections ?? null,
    onChange,
    onAccept: (nextValue) =>
      props.onAccept?.(nextValue as never, { validationError: null } as never),
    onOpen: props.onOpen,
    onClose: props.onClose,
    isValidValue: isValidPickerValue,
  });

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
        value={pickerDraft.draftValue}
        open={pickerDraft.open}
        closeOnSelect={false}
        ampm={false}
        onOpen={pickerDraft.handleOpen}
        onClose={pickerDraft.handleClose}
        onAccept={pickerDraft.handleAccept}
        onSelectedSectionsChange={(nextSelectedSections) => {
          pickerDraft.handleSelectedSectionsChange(nextSelectedSections);
          props.onSelectedSectionsChange?.(nextSelectedSections);
        }}
        onChange={pickerDraft.handleChange}
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
            onRequestClose: pickerDraft.handleClose,
          } as any,
        }}
      />
    </LocalizationProvider>
  );
}
