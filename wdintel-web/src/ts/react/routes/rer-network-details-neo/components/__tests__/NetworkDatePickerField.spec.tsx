/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';

const powerDatePickerMock = vi.fn((props: { onChange: (value: unknown) => void }) => null);

vi.mock('../../../../components/PowerDateTimePicker', () => ({
  PowerDatePicker: (props: { onChange: (value: unknown) => void }) => powerDatePickerMock(props),
}));

import { NetworkDatePickerField } from '.././NetworkDatePickerField';

// @test-scope safeguard: prevents a required network date from being cleared or an invalid date from being persisted.
describe('NetworkDatePickerField', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    powerDatePickerMock.mockClear();
    vi.clearAllMocks();
  });

  it('commits valid date changes immediately', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(<NetworkDatePickerField label="Від" value="2026-05-01" onChange={onChange} />);
    });

    const pickerProps = powerDatePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onChange(dayjs('2026-05-02'));
    });

    expect(onChange).toHaveBeenCalledWith('2026-05-02');

    act(() => {
      root.unmount();
    });
  });

  it('clears to empty only when empty values are allowed', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <NetworkDatePickerField
          label="Від"
          value="2026-05-01"
          allowEmpty={false}
          onChange={onChange}
        />,
      );
    });

    const pickerProps = powerDatePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onChange(null);
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });

    const emptyContainer = document.createElement('div');
    document.body.appendChild(emptyContainer);
    const emptyRoot = createRoot(emptyContainer);
    const emptyOnChange = vi.fn();

    act(() => {
      emptyRoot.render(
        <NetworkDatePickerField
          label="Від"
          value="2026-05-01"
          allowEmpty
          onChange={emptyOnChange}
        />,
      );
    });

    const emptyPickerProps = powerDatePickerMock.mock.calls.at(-1)?.[0];
    expect(emptyPickerProps).toBeDefined();

    act(() => {
      emptyPickerProps?.onChange(null);
    });

    expect(emptyOnChange).toHaveBeenCalledWith('');

    act(() => {
      emptyRoot.unmount();
    });
  });
});
