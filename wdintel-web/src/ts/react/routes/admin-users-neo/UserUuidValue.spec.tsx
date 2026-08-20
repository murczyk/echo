/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { UserUuidValue } from './UserUuidValue';

it('discloses the complete UUID on hover and focus without warnings', async () => {
  vi.useFakeTimers();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const uuid = '12345678-1234-1234-1234-123456789abc';
  try {
    act(() => root.render(createElement(UserUuidValue, { uuid, shortValue: '12345...89abc' })));
    const value = container.querySelector<HTMLElement>('[tabindex="0"]');
    expect(value?.textContent).toBe('12345...89abc');
    act(() => value?.focus());
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(uuid);
    act(() => value?.blur());
    act(() => value?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    await act(async () => vi.runAllTimers());
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(uuid);
  } finally {
    act(() => root.unmount());
    container.remove();
    const errors = consoleError.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    consoleError.mockRestore();
    vi.useRealTimers();
    expect(errors).not.toMatch(/warning|error|invalid prop|aria/i);
  }
});
