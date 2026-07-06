/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';

type PowerDateTimePickerMockInstance = {
  setDraftValue: (value: dayjs.Dayjs | null) => void;
  setEditing: (value: boolean) => void;
  onChange: (value: dayjs.Dayjs | null) => void;
  value: dayjs.Dayjs | null;
};

const powerDateTimePickerInstances: Array<PowerDateTimePickerMockInstance | undefined> = [];
const powerDateTimePickerMock = vi.fn(
  (props: { value: dayjs.Dayjs | null; onChange: (value: dayjs.Dayjs | null) => void }) => null,
);

function PowerDateTimePickerMock(props: {
  value: dayjs.Dayjs | null;
  onChange: (value: dayjs.Dayjs | null) => void;
}) {
  const instanceIdRef = useRef<number | null>(null);
  powerDateTimePickerMock(props);
  const [draftValue, setDraftValue] = useState(props.value);
  const [isEditing, setIsEditing] = useState(false);
  const isEditingRef = useRef(false);

  if (instanceIdRef.current == null) {
    instanceIdRef.current = powerDateTimePickerInstances.length;
  }

  powerDateTimePickerInstances[instanceIdRef.current] = {
    setDraftValue,
    setEditing: setIsEditing,
    onChange: props.onChange,
    value: draftValue,
  };

  useEffect(() => {
    if (!isEditingRef.current && !isEditing) {
      setDraftValue(props.value);
    }
  }, [isEditing, props.value]);

  useEffect(
    () => () => {
      if (instanceIdRef.current != null) {
        powerDateTimePickerInstances[instanceIdRef.current] = undefined;
      }
    },
    [],
  );

  return (
    <div
      data-testid="power-date-time-picker"
      data-value={draftValue?.format('YYYY-MM-DDTHH:mm') ?? ''}
    />
  );
}

vi.mock('./PowerDateTimePicker', () => ({
  PowerDateTimePicker: (props: {
    value: dayjs.Dayjs | null;
    onChange: (value: unknown) => void;
  }) => (
    <PowerDateTimePickerMock
      {...(props as { value: dayjs.Dayjs | null; onChange: (value: dayjs.Dayjs | null) => void })}
    />
  ),
}));

import { DateTimeRangeControl, getDateTimeRangeControlTextFieldSx } from './DateTimeRangeControl';

describe('DateTimeRangeControl', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    powerDateTimePickerMock.mockClear();
    powerDateTimePickerInstances.length = 0;
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

  it('keeps the active datetime draft across a stale parent rerender', () => {
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

    const pickerInputs = document.body.querySelectorAll<HTMLElement>(
      '[data-testid="power-date-time-picker"]',
    );
    expect(pickerInputs).toHaveLength(2);

    act(() => {
      const toPicker = powerDateTimePickerInstances[1];
      expect(toPicker).toBeDefined();
      toPicker?.setEditing(true);
      const nextValue = dayjs('2026-05-05T15:00');
      toPicker?.setDraftValue(nextValue);
      toPicker?.onChange(nextValue);
    });

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      fromDateTimeStr: '2026-05-01T10:00',
      toDateTimeStr: '2026-05-05T15:00',
    });

    act(() => {
      root.render(
        <DateTimeRangeControl
          value={{ fromDateTimeStr: '2026-05-01T10:00', toDateTimeStr: '2026-05-02T10:00' }}
          onChange={onChange}
        />,
      );
    });

    const rerenderedPickerInputs = document.body.querySelectorAll<HTMLElement>(
      '[data-testid="power-date-time-picker"]',
    );
    expect(rerenderedPickerInputs[1]?.dataset.value).toBe('2026-05-05T15:00');

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
