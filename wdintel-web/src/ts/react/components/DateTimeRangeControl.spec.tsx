/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';

const powerDateTimePickerMock = vi.fn(
  (props: { allowEmpty?: boolean; onChange: (value: unknown) => void }) => null,
);

vi.mock('./PowerDateTimePicker', () => ({
  PowerDateTimePicker: (props: { allowEmpty?: boolean; onChange: (value: unknown) => void }) =>
    powerDateTimePickerMock(props),
}));

import { DateTimeRangeControl, getDateTimeRangeControlTextFieldSx } from './DateTimeRangeControl';

describe('DateTimeRangeControl', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    powerDateTimePickerMock.mockClear();
    vi.clearAllMocks();
  });

  it('propagates valid picker changes immediately', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <DateTimeRangeControl
          value={{ fromDateTimeStr: '2026-05-01T10:00', toDateTimeStr: '2026-05-02T10:00' }}
          onChange={onChange}
        />,
      );
    });

    act(() => {
      container.querySelector('input')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const fromPickerProps = powerDateTimePickerMock.mock.calls[0]?.[0];
    const toPickerProps = powerDateTimePickerMock.mock.calls[1]?.[0];
    expect(fromPickerProps).toBeDefined();
    expect(toPickerProps).toBeDefined();
    expect(fromPickerProps?.allowEmpty).toBe(false);
    expect(toPickerProps?.allowEmpty).toBe(false);

    act(() => {
      fromPickerProps?.onChange(dayjs('2026-05-03T12:30'));
    });

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      fromDateTimeStr: '2026-05-03T12:30',
      toDateTimeStr: '2026-05-02T10:00',
    });

    act(() => {
      toPickerProps?.onChange(dayjs('2026-05-04T13:45'));
    });

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      fromDateTimeStr: '2026-05-03T12:30',
      toDateTimeStr: '2026-05-04T13:45',
    });

    act(() => {
      root.unmount();
    });
  });

  it('keeps the shared interval border colors aligned with the search field', () => {
    const closedSx = getDateTimeRangeControlTextFieldSx(false);
    const openSx = getDateTimeRangeControlTextFieldSx(true);
    const rootSx = closedSx['& .MuiOutlinedInput-root'] as {
      '& fieldset'?: { borderColor?: string };
      '&:hover fieldset'?: { borderColor?: string };
      '&.Mui-focused fieldset': { borderColor: string; borderWidth: number };
    };
    const openRootSx = openSx['& .MuiOutlinedInput-root'] as {
      '& fieldset': { borderColor: string };
      '&:hover fieldset': { borderColor: string };
      '&.Mui-focused fieldset': { borderColor: string; borderWidth: number };
    };

    expect(rootSx['& fieldset']?.borderColor).toBeUndefined();
    expect(rootSx['&:hover fieldset']?.borderColor).toBeUndefined();
    expect(rootSx['&.Mui-focused fieldset'].borderColor).toBe('primary.main');
    expect(rootSx['&.Mui-focused fieldset'].borderWidth).toBe(1);

    expect(openRootSx['& fieldset'].borderColor).toBe('primary.main');
    expect(openRootSx['&:hover fieldset'].borderColor).toBe('primary.main');
    expect(openRootSx['&.Mui-focused fieldset'].borderColor).toBe('primary.main');
  });
});
