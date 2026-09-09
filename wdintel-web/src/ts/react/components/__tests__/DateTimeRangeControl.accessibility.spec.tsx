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

vi.mock('../PowerDateTimePicker.tsx', () => ({
  PowerDateTimePicker: (props: PowerDateTimePickerMockProps) => (
    <PowerDateTimePickerMock {...props} />
  ),
}));

import { DateTimeRangeControl } from '../DateTimeRangeControl.tsx';
import { APP_DATETIME_INPUT_MAX, APP_DATETIME_INPUT_MIN, APP_TIME_ZONE } from '../../utils/misc.ts';

const fixedNow = new Date('2026-05-01T12:00:00Z');
const fixedToday = dayjs(fixedNow).tz(APP_TIME_ZONE).startOf('day');
const fixedTomorrow = fixedToday.add(1, 'day');

// @test-scope safeguard: prevents controlled date-range edits, bounds, presets, and accessible trigger state from losing the operator's intended interval
describe('DateTimeRangeControl', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    powerDateTimePickerMock.mockClear();
    powerDateTimePickerInstances.length = 0;
    vi.clearAllMocks();
  });

  it('renders an icon-only trigger with the full interval as its accessible label', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <DateTimeRangeControl
          value={{ fromDateTimeStr: '2026-05-05T10:00', toDateTimeStr: '2026-05-06T10:00' }}
          onChange={vi.fn()}
          now={fixedNow}
          displayMode="icon"
        />,
      );
    });

    expect(container.querySelector('input')).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Інтервал: 05.05 10:00 — 06.05 10:00"]',
    );
    expect(trigger).not.toBeNull();

    act(() => trigger?.click());
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');

    act(() => root.unmount());
  });
});
