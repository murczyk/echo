/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
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

type PowerDateTimePickerMockProps = {
  value: dayjs.Dayjs | null;
  onChange: (value: dayjs.Dayjs | null) => void;
  allowEmpty?: boolean;
  disabled?: boolean;
  minDateTime?: dayjs.Dayjs;
  maxDateTime?: dayjs.Dayjs;
};

const powerDateTimePickerInstances: Array<PowerDateTimePickerMockInstance | undefined> = [];
const powerDateTimePickerMock = vi.fn((_props: PowerDateTimePickerMockProps) => null);

vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material');
  return {
    ...actual,
    Button: ({ variant, ...props }: { variant?: string; [key: string]: unknown }) =>
      createElement(actual.Button, { ...props, 'data-variant': variant }),
  };
});

function PowerDateTimePickerMock(props: PowerDateTimePickerMockProps) {
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
  PowerDateTimePicker: (props: PowerDateTimePickerMockProps) => (
    <PowerDateTimePickerMock {...props} />
  ),
}));

import { DateTimeRangeControl, getDateTimeRangeControlTextFieldSx } from './DateTimeRangeControl';
import { APP_DATETIME_INPUT_MAX, APP_DATETIME_INPUT_MIN, APP_TIME_ZONE } from '../utils/misc';

const fixedNow = new Date('2026-05-01T12:00:00Z');
const fixedToday = dayjs(fixedNow).tz(APP_TIME_ZONE).startOf('day');
const fixedTomorrow = fixedToday.add(1, 'day');

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
          value={{ fromDateTimeStr: '2026-05-05T10:00', toDateTimeStr: '2026-05-06T10:00' }}
          onChange={onChange}
          now={fixedNow}
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
    expect((fromPickerProps?.minDateTime as dayjs.Dayjs | null)?.format('YYYY-MM-DDTHH:mm')).toBe(
      dayjs.tz(APP_DATETIME_INPUT_MIN, APP_TIME_ZONE).format('YYYY-MM-DDTHH:mm'),
    );
    expect((fromPickerProps?.maxDateTime as dayjs.Dayjs | null)?.format('YYYY-MM-DDTHH:mm')).toBe(
      dayjs.tz('2026-05-06T10:00', APP_TIME_ZONE).format('YYYY-MM-DDTHH:mm'),
    );
    expect((toPickerProps?.minDateTime as dayjs.Dayjs | null)?.format('YYYY-MM-DDTHH:mm')).toBe(
      dayjs.tz('2026-05-05T10:00', APP_TIME_ZONE).format('YYYY-MM-DDTHH:mm'),
    );
    expect((toPickerProps?.maxDateTime as dayjs.Dayjs | null)?.format('YYYY-MM-DDTHH:mm')).toBe(
      dayjs.tz(APP_DATETIME_INPUT_MAX, APP_TIME_ZONE).format('YYYY-MM-DDTHH:mm'),
    );

    act(() => {
      fromPickerProps?.onChange(dayjs('2026-05-05T12:30'));
    });

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      fromDateTimeStr: '2026-05-05T12:30',
      toDateTimeStr: '2026-05-06T10:00',
    });

    act(() => {
      toPickerProps?.onChange(dayjs('2026-05-07T13:45'));
    });

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      fromDateTimeStr: '2026-05-05T12:30',
      toDateTimeStr: '2026-05-07T13:45',
    });

    act(() => {
      root.unmount();
    });
  });

  it('keeps the default today-to-tomorrow range valid on expand', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <DateTimeRangeControl
          value={{
            fromDateTimeStr: fixedToday.format('YYYY-MM-DDTHH:mm'),
            toDateTimeStr: fixedTomorrow.format('YYYY-MM-DDTHH:mm'),
          }}
          onChange={onChange}
          now={fixedNow}
        />,
      );
    });

    act(() => {
      container.querySelector('input')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const fromPickerProps = powerDateTimePickerMock.mock.calls[0]?.[0];
    const toPickerProps = powerDateTimePickerMock.mock.calls[1]?.[0];

    expect((fromPickerProps?.maxDateTime as dayjs.Dayjs | null)?.format('YYYY-MM-DDTHH:mm')).toBe(
      fixedTomorrow.format('YYYY-MM-DDTHH:mm'),
    );
    expect((toPickerProps?.minDateTime as dayjs.Dayjs | null)?.format('YYYY-MM-DDTHH:mm')).toBe(
      fixedToday.format('YYYY-MM-DDTHH:mm'),
    );

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
          now={fixedNow}
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
          now={fixedNow}
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

  it('applies the today preset in the app timezone and closes the popover', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <DateTimeRangeControl
          value={{ fromDateTimeStr: '2026-04-30T10:00', toDateTimeStr: '2026-05-01T10:00' }}
          onChange={onChange}
          now={fixedNow}
        />,
      );
    });
    act(() => {
      container.querySelector('input')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const todayButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Сьогодні',
    );
    const oneDayButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '1 дн',
    );
    expect(todayButton).not.toBeUndefined();
    expect(oneDayButton).not.toBeUndefined();
    expect(
      Array.from(document.body.querySelectorAll('button')).indexOf(
        todayButton as HTMLButtonElement,
      ),
    ).toBeLessThan(
      Array.from(document.body.querySelectorAll('button')).indexOf(
        oneDayButton as HTMLButtonElement,
      ),
    );

    act(() => {
      todayButton?.click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      fromDateTimeStr: '2026-05-01T00:00',
      toDateTimeStr: '2026-05-01T23:59',
    });
    expect(container.querySelector('[aria-haspopup="dialog"]')?.getAttribute('aria-expanded')).toBe(
      'false',
    );

    act(() => {
      root.unmount();
    });
  });

  it('uses the injected time source for rolling presets and clears preset state on manual edits', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <DateTimeRangeControl
          value={{ fromDateTimeStr: '2026-04-30T10:00', toDateTimeStr: '2026-05-01T10:00' }}
          onChange={onChange}
          now={fixedNow}
        />,
      );
    });
    act(() => {
      container.querySelector('input')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const oneDayButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === '1 дн',
    );
    act(() => {
      oneDayButton?.click();
    });
    expect(onChange).toHaveBeenCalledWith({
      fromDateTimeStr: '2026-04-30T15:00',
      toDateTimeStr: '2026-05-01T15:00',
    });

    act(() => {
      container.querySelector('input')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const fromPickerProps = powerDateTimePickerMock.mock.calls.at(-2)?.[0];
    act(() => {
      fromPickerProps?.onChange(dayjs('2026-05-01T13:00'));
    });
    expect(onChange).toHaveBeenCalledTimes(2);

    act(() => {
      root.unmount();
    });
  });

  it('uses the global maximum when the end value is absent or beyond it', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <DateTimeRangeControl
          value={{ fromDateTimeStr: '2026-05-01T10:00', toDateTimeStr: '' }}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      container.querySelector('input')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(
      (powerDateTimePickerMock.mock.calls[0]?.[0].maxDateTime as dayjs.Dayjs).format(
        'YYYY-MM-DDTHH:mm',
      ),
    ).toBe(dayjs.tz(APP_DATETIME_INPUT_MAX, APP_TIME_ZONE).format('YYYY-MM-DDTHH:mm'));

    act(() => {
      root.render(
        <DateTimeRangeControl
          value={{ fromDateTimeStr: '2026-05-01T10:00', toDateTimeStr: '2100-12-31T23:59:59' }}
          onChange={onChange}
        />,
      );
    });
    expect(
      (powerDateTimePickerMock.mock.calls.at(-2)?.[0].maxDateTime as dayjs.Dayjs).format(
        'YYYY-MM-DDTHH:mm',
      ),
    ).toBe(dayjs.tz(APP_DATETIME_INPUT_MAX, APP_TIME_ZONE).format('YYYY-MM-DDTHH:mm'));

    act(() => {
      root.unmount();
    });
  });

  it('preserves the year 2100 end boundary and picker maximum', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <DateTimeRangeControl
          value={{ fromDateTimeStr: '2100-12-31T00:00', toDateTimeStr: '2100-12-31T23:59' }}
          onChange={onChange}
        />,
      );
    });
    act(() => {
      container.querySelector('input')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const toPickerProps = powerDateTimePickerMock.mock.calls[1]?.[0];
    expect((toPickerProps?.maxDateTime as dayjs.Dayjs).format('YYYY-MM-DDTHH:mm')).toBe(
      '2100-12-31T23:59',
    );

    act(() => {
      toPickerProps?.onChange(dayjs.tz('2100-12-31T23:59', APP_TIME_ZONE));
    });
    expect(onChange).toHaveBeenCalledWith({
      fromDateTimeStr: '2100-12-31T00:00',
      toDateTimeStr: '2100-12-31T23:59',
    });

    act(() => {
      root.unmount();
    });
  });

  it('tracks active preset variants and clears them after manual editing', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <DateTimeRangeControl
          value={{ fromDateTimeStr: '2026-04-30T10:00', toDateTimeStr: '2026-05-01T10:00' }}
          onChange={onChange}
          now={fixedNow}
        />,
      );
    });
    const open = () => {
      act(() => {
        container.querySelector('input')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    };
    const button = (label: string) =>
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (candidate) => candidate.textContent === label,
      );

    open();
    act(() => {
      button('Сьогодні')?.click();
    });

    open();
    expect(button('Сьогодні')?.dataset.variant).toBe('contained');
    const fromPickerProps = powerDateTimePickerMock.mock.calls.at(-2)?.[0];
    act(() => {
      fromPickerProps?.onChange(dayjs('2026-05-01T13:00'));
    });
    expect(button('Сьогодні')?.dataset.variant).toBe('outlined');

    act(() => {
      button('1 дн')?.click();
    });
    open();
    expect(button('1 дн')?.dataset.variant).toBe('contained');
    const toPickerProps = powerDateTimePickerMock.mock.calls.at(-1)?.[0];
    act(() => {
      toPickerProps?.onChange(dayjs('2026-05-02T13:00'));
    });
    expect(button('1 дн')?.dataset.variant).toBe('outlined');

    act(() => {
      root.unmount();
    });
  });

  it('does not open or apply presets when disabled', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();

    act(() => {
      root.render(
        <DateTimeRangeControl
          value={{ fromDateTimeStr: '2026-05-01T10:00', toDateTimeStr: '2026-05-02T10:00' }}
          onChange={onChange}
          disabled
        />,
      );
    });
    const input = container.querySelector<HTMLInputElement>('input');
    expect(input?.disabled).toBe(true);
    act(() => {
      input?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).not.toContain('Сьогодні');
    expect(onChange).not.toHaveBeenCalled();

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
