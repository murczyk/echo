/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';

const datePickerMock = vi.fn(
  (props: {
    value?: unknown;
    onChange: (value: unknown, context: { validationError: unknown }) => void;
    desktopModeMediaQuery: string;
    onOpen?: () => void;
    onClose?: () => void;
    onAccept?: (value: unknown, context: { validationError: unknown }) => void;
    onSelectedSectionsChange?: (value: unknown) => void;
    slotProps?: {
      actionBar?: { actions?: string[]; powerActions?: string[]; onRequestClose?: () => void };
    };
    slots?: { actionBar?: unknown };
  }) => null,
);
const dateTimePickerMock = vi.fn(
  (props: {
    value?: unknown;
    onChange: (value: unknown, context: { validationError: unknown }) => void;
    desktopModeMediaQuery: string;
    onOpen?: () => void;
    onClose?: () => void;
    onAccept?: (value: unknown, context: { validationError: unknown }) => void;
    onSelectedSectionsChange?: (value: unknown) => void;
    slotProps?: {
      actionBar?: { actions?: string[]; powerActions?: string[]; onRequestClose?: () => void };
    };
    slots?: { actionBar?: unknown };
  }) => null,
);
const localizationProviderMock = vi.fn(({ children }: { children: ReactNode }) => children);
vi.mock('@mui/x-date-pickers/hooks/usePickersTranslations', () => ({
  usePickersTranslations: () => ({
    clearButtonLabel: 'Clear',
    todayButtonLabel: 'Today',
    okButtonLabel: 'OK',
    cancelButtonLabel: 'Cancel',
  }),
}));

vi.mock('@mui/x-date-pickers/DatePicker', () => ({
  DatePicker: (props: {
    value?: unknown;
    onChange: (value: unknown, context: { validationError: unknown }) => void;
    desktopModeMediaQuery: string;
    onOpen?: () => void;
    onClose?: () => void;
    onAccept?: (value: unknown, context: { validationError: unknown }) => void;
    onSelectedSectionsChange?: (value: unknown) => void;
    slotProps?: {
      actionBar?: { actions?: string[]; powerActions?: string[]; onRequestClose?: () => void };
    };
    slots?: { actionBar?: unknown };
  }) => datePickerMock(props),
}));

vi.mock('@mui/x-date-pickers/DateTimePicker', () => ({
  DateTimePicker: (props: {
    value?: unknown;
    onChange: (value: unknown, context: { validationError: unknown }) => void;
    desktopModeMediaQuery: string;
    onOpen?: () => void;
    onClose?: () => void;
    onAccept?: (value: unknown, context: { validationError: unknown }) => void;
    onSelectedSectionsChange?: (value: unknown) => void;
    slotProps?: {
      actionBar?: { actions?: string[]; powerActions?: string[]; onRequestClose?: () => void };
    };
    slots?: { actionBar?: unknown };
  }) => dateTimePickerMock(props),
}));

vi.mock('@mui/x-date-pickers/LocalizationProvider', () => ({
  LocalizationProvider: (props: {
    children: ReactNode;
    localeText?: { cancelButtonLabel?: string };
  }) => localizationProviderMock(props),
}));

vi.mock('@mui/x-date-pickers/AdapterDayjs', () => ({
  AdapterDayjs: function AdapterDayjs() {},
}));

import { PowerDatePicker, PowerDateTimePicker } from '../../PowerDateTimePicker';

// @test-scope safeguard: prevents controlled date and datetime drafts from submitting stale typing, losing an accepted value, or persisting an invalid null
describe('PowerDateTimePicker', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    datePickerMock.mockClear();
    dateTimePickerMock.mockClear();
    localizationProviderMock.mockClear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('debounces collapsed date typing', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(<PowerDatePicker value={dayjs('2026-05-01')} onChange={onChange} label="Дата" />);
    });

    const pickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();
    expect(pickerProps?.slotProps?.actionBar?.powerActions).toEqual(['close', 'accept']);

    act(() => {
      pickerProps?.onSelectedSectionsChange?.('day');
      pickerProps?.onChange(dayjs('invalid'), { validationError: 'invalid' });
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      pickerProps?.onChange(dayjs('2026-05-02'), { validationError: null });
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(
      (datePickerMock.mock.calls.at(-1)?.[0]?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DD'),
    ).toBe('2026-05-02');

    act(() => {
      vi.advanceTimersByTime(249);
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(onChange.mock.calls.at(-1)?.[0]?.format('YYYY-MM-DD')).toBe('2026-05-02');

    act(() => {
      root.unmount();
    });
  });

  it('syncs the controlled date value after a committed manual edit', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(<PowerDatePicker value={dayjs('2026-05-01')} onChange={onChange} label="Дата" />);
    });

    const pickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onSelectedSectionsChange?.('day');
      pickerProps?.onChange(dayjs('2026-05-03'), { validationError: null });
      vi.advanceTimersByTime(250);
      pickerProps?.onSelectedSectionsChange?.(null);
    });

    expect(onChange).toHaveBeenCalledWith(dayjs('2026-05-03'));

    act(() => {
      root.render(<PowerDatePicker value={dayjs('2026-05-04')} onChange={onChange} label="Дата" />);
    });

    expect(
      (datePickerMock.mock.calls.at(-1)?.[0]?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DD'),
    ).toBe('2026-05-04');

    act(() => {
      root.unmount();
    });
  });

  it('syncs the controlled date value when keyboard editing ends', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(<PowerDatePicker value={dayjs('2026-05-01')} onChange={onChange} label="Дата" />);
    });

    const pickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onSelectedSectionsChange?.('day');
      pickerProps?.onChange(dayjs('2026-05-03'), { validationError: null });
      vi.advanceTimersByTime(250);
    });

    expect(
      (datePickerMock.mock.calls.at(-1)?.[0]?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DD'),
    ).toBe('2026-05-03');

    act(() => {
      root.render(<PowerDatePicker value={dayjs('2026-05-04')} onChange={onChange} label="Дата" />);
    });

    expect(
      (datePickerMock.mock.calls.at(-1)?.[0]?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DD'),
    ).toBe('2026-05-03');

    act(() => {
      datePickerMock.mock.calls.at(-1)?.[0]?.onSelectedSectionsChange?.(null);
    });

    expect(
      (datePickerMock.mock.calls.at(-1)?.[0]?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DD'),
    ).toBe('2026-05-04');

    act(() => {
      root.unmount();
    });
  });

  it('clears the open date draft when the controlled value becomes null', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(<PowerDatePicker value={dayjs('2026-05-01')} onChange={onChange} label="Дата" />);
    });

    const pickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onOpen?.();
    });

    act(() => {
      datePickerMock.mock.calls.at(-1)?.[0]?.onChange(dayjs('2026-05-03'), {
        validationError: null,
      });
    });

    expect(
      (datePickerMock.mock.calls.at(-1)?.[0]?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DD'),
    ).toBe('2026-05-03');

    act(() => {
      root.render(<PowerDatePicker value={null} onChange={onChange} label="Дата" />);
    });

    expect(datePickerMock.mock.calls.at(-1)?.[0]?.value).toBeNull();

    act(() => {
      datePickerMock.mock.calls.at(-1)?.[0]?.onAccept?.(null, { validationError: null });
    });

    expect(onChange).not.toHaveBeenCalledWith(dayjs('2026-05-03'));

    act(() => {
      root.unmount();
    });
  });

  it('clears pending manual date input when the controlled value becomes null', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(<PowerDatePicker value={dayjs('2026-05-01')} onChange={onChange} label="Дата" />);
    });

    const pickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onSelectedSectionsChange?.('day');
      pickerProps?.onChange(dayjs('2026-05-03'), { validationError: null });
    });

    act(() => {
      root.render(<PowerDatePicker value={null} onChange={onChange} label="Дата" />);
    });

    expect(datePickerMock.mock.calls.at(-1)?.[0]?.value).toBeNull();

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(onChange).not.toHaveBeenCalledWith(dayjs('2026-05-03'));

    act(() => {
      root.unmount();
    });
  });

  it('applies expanded date selections only after ok', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(<PowerDatePicker value={dayjs('2026-05-01')} onChange={onChange} label="Дата" />);
    });

    const pickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onOpen?.();
    });

    const openPickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect(openPickerProps).toBeDefined();
    expect((openPickerProps?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DD')).toBe('2026-05-01');

    act(() => {
      openPickerProps?.onChange(dayjs('2026-05-02'), { validationError: null });
    });

    expect(onChange).not.toHaveBeenCalled();

    const updatedOpenPickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect(updatedOpenPickerProps).toBeDefined();
    expect((updatedOpenPickerProps?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DD')).toBe(
      '2026-05-02',
    );

    act(() => {
      updatedOpenPickerProps?.onAccept?.(dayjs('2026-05-02'), { validationError: null });
    });

    expect(onChange).toHaveBeenCalledWith(dayjs('2026-05-02'));

    act(() => {
      updatedOpenPickerProps?.onClose?.();
      root.unmount();
    });
  });

  it('restores the controlled datetime value when closed without accept', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-01T10:00')} onChange={onChange} label="Час" />,
      );
    });

    const pickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onOpen?.();
    });

    const openPickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect((openPickerProps?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DDTHH:mm')).toBe(
      '2026-05-01T10:00',
    );

    act(() => {
      openPickerProps?.onChange(dayjs('2026-05-02T11:30'), { validationError: null });
    });

    const draftPickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect((draftPickerProps?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DDTHH:mm')).toBe(
      '2026-05-02T11:30',
    );

    act(() => {
      draftPickerProps?.onClose?.();
    });

    const closedPickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect((closedPickerProps?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DDTHH:mm')).toBe(
      '2026-05-01T10:00',
    );

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it('ignores null by default and allows it only when explicitly enabled', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(<PowerDatePicker value={dayjs('2026-05-01')} onChange={onChange} label="Дата" />);
    });

    const pickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onChange(null, { validationError: null });
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
        <PowerDatePicker
          value={dayjs('2026-05-01')}
          onChange={emptyOnChange}
          allowEmpty
          label="Дата"
        />,
      );
    });

    const emptyPickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect(emptyPickerProps).toBeDefined();

    act(() => {
      emptyPickerProps?.onChange(null, { validationError: null });
    });

    expect(emptyOnChange).toHaveBeenCalledWith(null);

    act(() => {
      emptyRoot.unmount();
    });
  });

  it('debounces collapsed datetime typing', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-01T10:00')} onChange={onChange} label="Час" />,
      );
    });

    const pickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps?.desktopModeMediaQuery).toBe('@media all');
    expect(pickerProps?.slotProps?.actionBar?.actions).toEqual([]);
    expect(pickerProps?.slotProps?.actionBar?.powerActions).toEqual(['close', 'accept']);

    act(() => {
      pickerProps?.onSelectedSectionsChange?.('hours');
      pickerProps?.onChange(dayjs('invalid'), { validationError: 'invalid' });
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      pickerProps?.onChange(dayjs('2026-05-02T11:30'), { validationError: null });
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(
      (dateTimePickerMock.mock.calls.at(-1)?.[0]?.value as dayjs.Dayjs | null)?.format(
        'YYYY-MM-DDTHH:mm',
      ),
    ).toBe('2026-05-02T11:30');

    act(() => {
      vi.advanceTimersByTime(249);
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(onChange.mock.calls.at(-1)?.[0]?.format('YYYY-MM-DDTHH:mm')).toBe('2026-05-02T11:30');

    act(() => {
      root.unmount();
    });
  });

  it('syncs the controlled datetime value after a committed manual edit', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-01T10:00')} onChange={onChange} label="Час" />,
      );
    });

    const pickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onSelectedSectionsChange?.('hours');
      pickerProps?.onChange(dayjs('2026-05-03T15:20'), { validationError: null });
      vi.advanceTimersByTime(250);
      pickerProps?.onSelectedSectionsChange?.(null);
    });

    expect(onChange).toHaveBeenCalledWith(dayjs('2026-05-03T15:20'));

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-04T16:30')} onChange={onChange} label="Час" />,
      );
    });

    expect(
      (dateTimePickerMock.mock.calls.at(-1)?.[0]?.value as dayjs.Dayjs | null)?.format(
        'YYYY-MM-DDTHH:mm',
      ),
    ).toBe('2026-05-04T16:30');

    act(() => {
      root.unmount();
    });
  });

  it('syncs the controlled datetime value when keyboard editing ends', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-01T10:00')} onChange={onChange} label="Час" />,
      );
    });

    const pickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onSelectedSectionsChange?.('hours');
      pickerProps?.onChange(dayjs('2026-05-03T15:20'), { validationError: null });
      vi.advanceTimersByTime(250);
    });

    expect(
      (dateTimePickerMock.mock.calls.at(-1)?.[0]?.value as dayjs.Dayjs | null)?.format(
        'YYYY-MM-DDTHH:mm',
      ),
    ).toBe('2026-05-03T15:20');

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-04T16:30')} onChange={onChange} label="Час" />,
      );
    });

    expect(
      (dateTimePickerMock.mock.calls.at(-1)?.[0]?.value as dayjs.Dayjs | null)?.format(
        'YYYY-MM-DDTHH:mm',
      ),
    ).toBe('2026-05-03T15:20');

    act(() => {
      dateTimePickerMock.mock.calls.at(-1)?.[0]?.onSelectedSectionsChange?.(null);
    });

    expect(
      (dateTimePickerMock.mock.calls.at(-1)?.[0]?.value as dayjs.Dayjs | null)?.format(
        'YYYY-MM-DDTHH:mm',
      ),
    ).toBe('2026-05-04T16:30');

    act(() => {
      root.unmount();
    });
  });

  it('clears the open datetime draft when the controlled value becomes null', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-01T10:00')} onChange={onChange} label="Час" />,
      );
    });

    const pickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onOpen?.();
    });

    act(() => {
      dateTimePickerMock.mock.calls.at(-1)?.[0]?.onChange(dayjs('2026-05-03T15:20'), {
        validationError: null,
      });
    });

    expect(
      (dateTimePickerMock.mock.calls.at(-1)?.[0]?.value as dayjs.Dayjs | null)?.format(
        'YYYY-MM-DDTHH:mm',
      ),
    ).toBe('2026-05-03T15:20');

    act(() => {
      root.render(<PowerDateTimePicker value={null} onChange={onChange} label="Час" />);
    });

    expect(dateTimePickerMock.mock.calls.at(-1)?.[0]?.value).toBeNull();

    act(() => {
      dateTimePickerMock.mock.calls.at(-1)?.[0]?.onAccept?.(null, { validationError: null });
    });

    expect(onChange).not.toHaveBeenCalledWith(dayjs('2026-05-03T15:20'));

    act(() => {
      root.unmount();
    });
  });

  it('clears pending manual datetime input when the controlled value becomes null', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-01T10:00')} onChange={onChange} label="Час" />,
      );
    });

    const pickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onSelectedSectionsChange?.('hours');
      pickerProps?.onChange(dayjs('2026-05-03T15:20'), { validationError: null });
    });

    act(() => {
      root.render(<PowerDateTimePicker value={null} onChange={onChange} label="Час" />);
    });

    expect(dateTimePickerMock.mock.calls.at(-1)?.[0]?.value).toBeNull();

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(onChange).not.toHaveBeenCalledWith(dayjs('2026-05-03T15:20'));

    act(() => {
      root.unmount();
    });
  });

  it('applies expanded picker ui selections only after ok', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-01T10:00')} onChange={onChange} label="Час" />,
      );
    });

    const pickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();
    expect(pickerProps?.slotProps?.actionBar?.powerActions).toEqual(['close', 'accept']);

    act(() => {
      pickerProps?.onOpen?.();
    });

    const openPickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(openPickerProps).toBeDefined();
    expect(openPickerProps?.value?.format('YYYY-MM-DDTHH:mm')).toBe('2026-05-01T10:00');

    act(() => {
      openPickerProps?.onChange(dayjs('2026-05-02T11:30'), { validationError: null });
    });

    expect(onChange).not.toHaveBeenCalled();

    const updatedOpenPickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(updatedOpenPickerProps).toBeDefined();
    expect(updatedOpenPickerProps?.value?.format('YYYY-MM-DDTHH:mm')).toBe('2026-05-02T11:30');

    act(() => {
      updatedOpenPickerProps?.onAccept?.(dayjs('2026-05-02T11:30'), { validationError: null });
    });

    expect(onChange).toHaveBeenCalledWith(dayjs('2026-05-02T11:30'));

    act(() => {
      updatedOpenPickerProps?.onClose?.();
      root.unmount();
    });
  });

  it('keeps an open datetime draft when the parent rerenders with a stale value', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-01T10:00')} onChange={onChange} label="Час" />,
      );
    });

    const pickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onOpen?.();
    });

    const openPickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect((openPickerProps?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DDTHH:mm')).toBe(
      '2026-05-01T10:00',
    );

    act(() => {
      openPickerProps?.onChange(dayjs('2026-05-02T11:30'), { validationError: null });
    });

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-01T10:00')} onChange={onChange} label="Час" />,
      );
    });

    const rerenderedPickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect((rerenderedPickerProps?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DDTHH:mm')).toBe(
      '2026-05-02T11:30',
    );

    act(() => {
      rerenderedPickerProps?.onClose?.();
    });

    const closedPickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect((closedPickerProps?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DDTHH:mm')).toBe(
      '2026-05-01T10:00',
    );

    act(() => {
      root.unmount();
    });
  });

  it('applies only the latest collapsed datetime change', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <PowerDateTimePicker
          value={dayjs('2026-05-01T10:00')}
          onChange={onChange}
          manualInputDebounceMs={250}
          label="Час"
        />,
      );
    });

    const pickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onSelectedSectionsChange?.('hours');
      pickerProps?.onChange(dayjs('2026-05-02T11:00'), { validationError: null });
      vi.advanceTimersByTime(100);
      pickerProps?.onSelectedSectionsChange?.('hours');
      pickerProps?.onChange(dayjs('2026-05-03T12:30'), { validationError: null });
      vi.advanceTimersByTime(249);
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls.at(-1)?.[0]?.format('YYYY-MM-DDTHH:mm')).toBe('2026-05-03T12:30');

    act(() => {
      root.unmount();
    });
  });

  it('keeps an open date draft when the parent rerenders with a stale value', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(<PowerDatePicker value={dayjs('2026-05-01')} onChange={onChange} label="Дата" />);
    });

    const pickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onOpen?.();
    });

    const openPickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect((openPickerProps?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DD')).toBe('2026-05-01');

    act(() => {
      openPickerProps?.onChange(dayjs('2026-05-02'), { validationError: null });
    });

    act(() => {
      root.render(<PowerDatePicker value={dayjs('2026-05-01')} onChange={onChange} label="Дата" />);
    });

    const rerenderedPickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect((rerenderedPickerProps?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DD')).toBe(
      '2026-05-02',
    );

    act(() => {
      rerenderedPickerProps?.onClose?.();
    });

    const closedPickerProps = datePickerMock.mock.calls.at(-1)?.[0];
    expect((closedPickerProps?.value as dayjs.Dayjs | null)?.format('YYYY-MM-DD')).toBe(
      '2026-05-01',
    );

    act(() => {
      root.unmount();
    });
  });

  it('flushes pending typing on open and continues debouncing manual edits while open', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-01T10:00')} onChange={onChange} label="Час" />,
      );
    });

    const pickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onSelectedSectionsChange?.('hours');
      pickerProps?.onChange(dayjs('2026-05-02T11:30'), { validationError: null });
      vi.advanceTimersByTime(100);
    });

    act(() => {
      pickerProps?.onOpen?.();
    });

    expect(onChange.mock.calls.at(-1)?.[0]?.format('YYYY-MM-DDTHH:mm')).toBe('2026-05-02T11:30');

    const openPickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(openPickerProps).toBeDefined();

    act(() => {
      openPickerProps?.onSelectedSectionsChange?.('hours');
      openPickerProps?.onChange(dayjs('2026-05-03T12:45'), { validationError: null });
    });

    expect(onChange.mock.calls.at(-1)?.[0]?.format('YYYY-MM-DDTHH:mm')).toBe('2026-05-02T11:30');

    act(() => {
      vi.advanceTimersByTime(249);
    });

    expect(onChange.mock.calls.at(-1)?.[0]?.format('YYYY-MM-DDTHH:mm')).toBe('2026-05-02T11:30');

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(onChange.mock.calls.at(-1)?.[0]?.format('YYYY-MM-DDTHH:mm')).toBe('2026-05-03T12:45');

    act(() => {
      openPickerProps?.onClose?.();
      root.unmount();
    });
  });

  it('clears pending manual typing when controlled value becomes null', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <PowerDateTimePicker value={dayjs('2026-05-01T10:00')} onChange={onChange} label="Час" />,
      );
    });

    const pickerProps = dateTimePickerMock.mock.calls.at(-1)?.[0];
    expect(pickerProps).toBeDefined();

    act(() => {
      pickerProps?.onSelectedSectionsChange?.('hours');
      pickerProps?.onChange(dayjs('2026-05-02T11:30'), { validationError: null });
    });

    act(() => {
      root.render(<PowerDateTimePicker value={null} onChange={onChange} label="Час" />);
    });

    expect(dateTimePickerMock.mock.calls.at(-1)?.[0]?.open).toBeDefined();

    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});
