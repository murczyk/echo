import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import { Button, Popover } from '@mui/material';
import dayjs from 'dayjs';
import { useState } from 'react';
import { PowerDatePicker } from '../../components/PowerDateTimePicker';
import { periodError, today, type StatsState } from './state';

export function StatisticsPeriod({
  state,
  update,
}: {
  state: StatsState;
  update: (patch: Partial<StatsState>) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [range, setRange] = useState({ from: state.from, to: state.to });
  const error = periodError({ ...state, ...range });
  return (
    <>
      <Button
        className="message-statistics-period"
        variant="outlined"
        color="inherit"
        endIcon={<CalendarMonthIcon />}
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        onClick={(event) => {
          setRange({ from: state.from, to: state.to });
          setAnchor(event.currentTarget);
        }}
      >
        <span className="message-statistics-period-label">
          Період: {dayjs(state.from).format('D.MM')}
          {state.from !== state.to ? ` - ${dayjs(state.to).format('D.MM')}` : ''}
        </span>
      </Button>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { className: 'message-statistics-period-picker' } }}
      >
        <div role="dialog" aria-label="Період статистики">
          <div className="message-statistics-period-fields">
            <PowerDatePicker
              label="Від дати"
              value={dayjs(range.from)}
              maxDate={dayjs(today())}
              onChange={(date) => {
                if (date?.isValid())
                  setRange((current) => ({ ...current, from: date.format('YYYY-MM-DD') }));
              }}
              slotProps={{ textField: { size: 'small' } }}
            />
            <PowerDatePicker
              label="До дати включно"
              value={dayjs(range.to)}
              maxDate={dayjs(today())}
              onChange={(date) => {
                if (date?.isValid())
                  setRange((current) => ({ ...current, to: date.format('YYYY-MM-DD') }));
              }}
              slotProps={{ textField: { size: 'small' } }}
            />
          </div>
          {error ? <p role="alert">{error}</p> : null}
          <div className="message-statistics-period-actions">
            <Button onClick={() => setAnchor(null)}>Скасувати</Button>
            <Button
              disabled={Boolean(error)}
              onClick={() => {
                update(range);
                setAnchor(null);
              }}
            >
              Застосувати
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}
