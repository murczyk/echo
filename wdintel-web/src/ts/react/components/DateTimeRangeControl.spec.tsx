/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';

const dateTimePickerMock = vi.fn((props: { onChange: (value: unknown) => void; onAccept: (value: unknown) => void }) => null);

vi.mock('@mui/x-date-pickers/DateTimePicker', () => ({
  DateTimePicker: (props: { onChange: (value: unknown) => void; onAccept: (value: unknown) => void }) => dateTimePickerMock(props),
}));

vi.mock('@mui/x-date-pickers/LocalizationProvider', () => ({
  LocalizationProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@mui/x-date-pickers/AdapterDayjs', () => ({
  AdapterDayjs: function AdapterDayjs() {},
}));

import { DateTimeRangeControl } from './DateTimeRangeControl';

describe('DateTimeRangeControl', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    dateTimePickerMock.mockClear();
    vi.clearAllMocks();
  });

  it('commits picker changes only on accept', () => {
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

    const fromPickerProps = dateTimePickerMock.mock.calls[0]?.[0];
    expect(fromPickerProps).toBeDefined();

    act(() => {
      fromPickerProps?.onChange(dayjs('2026-05-03T12:30'));
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      fromPickerProps?.onAccept(dayjs('2026-05-03T12:30'));
    });

    expect(onChange).toHaveBeenCalledWith({
      fromDateTimeStr: '2026-05-03T12:30',
      toDateTimeStr: '2026-05-02T10:00',
    });

    act(() => {
      root.unmount();
    });
  });
});
