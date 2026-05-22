/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';

const datePickerMock = vi.fn((props: { onChange: (value: unknown) => void }) => null);

vi.mock('@mui/x-date-pickers/DatePicker', () => ({
  DatePicker: (props: { onChange: (value: unknown) => void }) => datePickerMock(props),
}));

import { NetworkDatePickerField } from './NetworkDatePickerField';

describe('NetworkDatePickerField', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    datePickerMock.mockClear();
    vi.clearAllMocks();
  });

  it('ignores invalid date values', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(<NetworkDatePickerField label="Від" value="" onChange={onChange} />);
    });

    const datePickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect(datePickerProps).toBeDefined();

    act(() => {
      datePickerProps?.onChange(dayjs('invalid'));
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});
