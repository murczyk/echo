/**
 * @vitest-environment happy-dom
 */
import dayjs from 'dayjs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessengerChatDateField } from '../MessengerChatDateField';

describe('MessengerChatDateField', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onJumpToDate = vi.fn();
  // The calendar opens on the current month and disables the future, so the clock is fixed mid-month.
  const month = dayjs(new Date(2026, 5, 1));

  const field = () =>
    container.querySelector<HTMLInputElement>('input[aria-label="Перейти до дати"]')!;
  const click = (element: Element | null | undefined) =>
    act(async () => void element?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const day = (n: number) =>
    [...document.querySelectorAll<HTMLButtonElement>('button[role="gridcell"]')].find(
      (item) => item.textContent === String(n),
    );
  const cross = () => container.querySelector('[aria-label="Очистити дату"]');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 20, 12));
    onJumpToDate.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<MessengerChatDateField onJumpToDate={onJumpToDate} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('is read-only and has no calendar icon or buttons to confirm', async () => {
    expect(field().readOnly).toBe(true);
    await click(field());
    expect(document.querySelector('button[aria-label="Відкрити календар"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/ОК|Закрити/);
  });

  it('jumps to a day as soon as it is tapped and shows it in the field', async () => {
    await click(field());
    await click(day(3));

    expect(onJumpToDate).toHaveBeenCalledTimes(1);
    expect(onJumpToDate).toHaveBeenCalledWith(
      month.date(3).startOf('day').valueOf(),
      month.date(3).endOf('day').valueOf(),
    );
    expect(field().value).toBe(month.date(3).format('DD.MM.YYYY'));
  });

  it('jumps again when the day that is already chosen is tapped', async () => {
    await click(field());
    await click(day(3));
    await click(field());
    await click(day(3));

    expect(onJumpToDate).toHaveBeenCalledTimes(2);
  });

  it('is only a calendar icon on a phone: no field, no date shown, no cross, and a tap still jumps', async () => {
    act(() => root.render(<MessengerChatDateField onJumpToDate={onJumpToDate} mobile />));
    expect(container.querySelector('input')).toBeNull();

    await click(container.querySelector('button[aria-label="Перейти до дати"]'));
    await click(day(3));

    expect(onJumpToDate).toHaveBeenCalledWith(
      month.date(3).startOf('day').valueOf(),
      month.date(3).endOf('day').valueOf(),
    );
    expect(cross()).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('opens with Enter on the field, but leaves Enter on the cross to the cross', async () => {
    const press = (element: Element | null) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      act(() => void element?.dispatchEvent(event));
      return event;
    };
    const calendarOpen = () => document.querySelector('button[role="gridcell"]') != null;
    // The popover leaves the DOM when its exit transition ends, a timer tick after the day is tapped.
    const calendarClosed = () => vi.waitFor(() => expect(calendarOpen()).toBe(false));

    await click(field());
    await click(day(1));
    await calendarClosed();

    expect(press(cross()).defaultPrevented).toBe(false);
    await calendarClosed();

    expect(press(field()).defaultPrevented).toBe(true);
    expect(calendarOpen()).toBe(true);
  });

  it('clears the field with the cross, without jumping or opening the calendar', async () => {
    expect(cross()).toBeNull();
    await click(field());
    await click(day(1));
    onJumpToDate.mockClear();
    expect(cross()).not.toBeNull();

    await click(cross());
    expect(field().value).toBe('');
    expect(cross()).toBeNull();
    expect(onJumpToDate).not.toHaveBeenCalled();
  });
});
