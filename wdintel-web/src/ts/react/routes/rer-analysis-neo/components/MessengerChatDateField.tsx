import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import ClearIcon from '@mui/icons-material/Clear';
import { IconButton, InputAdornment, Popover, TextField } from '@mui/material';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DateCalendar } from '@mui/x-date-pickers/DateCalendar';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { PickersDay, type PickersDayProps } from '@mui/x-date-pickers/PickersDay';
import dayjs, { type Dayjs } from 'dayjs';
import 'dayjs/locale/uk';
import { useRef, useState } from 'react';

type Props = {
  // The first and last millisecond of the tapped day; called as soon as it is tapped.
  onJumpToDate: (dayStartMs: number, dayEndMs: number) => void;
  disabled?: boolean;
  // The phone: only a calendar icon, the chosen date is not shown and there is nothing to clear.
  mobile?: boolean;
};

const DISPLAY_FORMAT = 'DD.MM.YYYY';

function ChosenDay({ chosen, day, ...props }: PickersDayProps<Dayjs> & { chosen: Dayjs | null }) {
  return <PickersDay {...props} day={day} selected={chosen != null && day.isSame(chosen, 'day')} />;
}

// "Go to a date": one read-only field that opens a calendar. A tap on a day jumps there and closes it, so there is
// nothing to type, confirm or close. The cross only clears the field.
export function MessengerChatDateField({ onJumpToDate, disabled = false, mobile = false }: Props) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Dayjs | null>(null);

  const pick = (day: Dayjs) => {
    setChosen(day);
    setOpen(false);
    onJumpToDate(day.startOf('day').valueOf(), day.endOf('day').valueOf());
  };

  return (
    <>
      {mobile ? (
        <IconButton
          ref={setAnchor}
          aria-label="Перейти до дати"
          aria-haspopup="dialog"
          disabled={disabled}
          onClick={() => setOpen(true)}
          // The look of the date icon in the page header's compact layout, so the same control reads the same.
          sx={{
            width: 40,
            height: 40,
            borderRadius: 1,
            border: '1px solid',
            borderColor: open ? 'primary.main' : 'divider',
            color: 'primary.main',
          }}
        >
          <CalendarMonthOutlinedIcon sx={{ fontSize: 18 }} />
        </IconButton>
      ) : (
        <TextField
          ref={setAnchor}
          size="small"
          value={chosen?.format(DISPLAY_FORMAT) ?? ''}
          placeholder="Перейти до дати"
          disabled={disabled}
          className="w-48"
          onClick={() => !disabled && setOpen(true)}
          inputProps={{
            'aria-label': 'Перейти до дати',
            'aria-haspopup': 'dialog',
            readOnly: true,
            className: 'cursor-pointer',
            // On the input, not the root: Enter and Space on the cross inside the field must reach the cross.
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setOpen(true);
              }
            },
          }}
          slotProps={{
            input: {
              className: 'cursor-pointer',
              endAdornment:
                chosen != null ? (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      edge="end"
                      aria-label="Очистити дату"
                      onClick={(event) => {
                        event.stopPropagation();
                        setChosen(null);
                      }}
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
            },
          }}
        />
      )}
      <Popover
        open={open}
        anchorEl={anchor}
        onClose={() => setOpen(false)}
        // The icon sits at the right edge of the phone, so the calendar opens leftwards from it.
        anchorOrigin={{ vertical: 'bottom', horizontal: mobile ? 'right' : 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: mobile ? 'right' : 'left' }}
      >
        <LocalizationProvider dateAdapter={AdapterDayjs} adapterLocale="uk">
          {/* The calendar's own value stays empty: tapping the day that is already chosen must still count as a tap. */}
          <DateCalendar
            value={null}
            onChange={(day) => day != null && pick(day)}
            disableFuture
            slots={{ day: ChosenDay }}
            slotProps={{ day: { chosen } as never }}
            referenceDate={chosen ?? dayjs()}
          />
        </LocalizationProvider>
      </Popover>
    </>
  );
}
