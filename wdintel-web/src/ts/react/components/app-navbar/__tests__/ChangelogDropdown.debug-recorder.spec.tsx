/**
 * @vitest-environment happy-dom
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registerPress = vi.hoisted(() => vi.fn());

vi.mock('../../../../debug-recorder', () => ({
  registerBrowserDebugRecorderPress: registerPress,
}));

import { ChangelogDropdown } from '../ChangelogDropdown';

const roots: Root[] = [];

const shared = {
  serverInfo: { mode: 'live', version: '2026.10.8' },
  deploymentMaintenance: null,
  changelogPreview: {
    version: '2026-10-8',
    preview: ['Безпечна діагностика'],
    fullUrl: '/changelog',
  },
  userLoaded: true,
  changelogLastSeenLoaded: true,
  changelogLastSeen: null,
};

function renderDropdown(
  value: typeof shared | Record<string, unknown> = shared,
  onOpenChangelog = vi.fn(),
) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  function Harness() {
    const [openDropdown, setOpenDropdown] = useState<string | null>(null);
    return (
      <ChangelogDropdown
        shared={value}
        openDropdown={openDropdown}
        setOpenDropdown={setOpenDropdown}
        onOpenChangelog={onOpenChangelog}
      />
    );
  }

  act(() => root.render(<Harness />));
  return { container, button: container.querySelector<HTMLButtonElement>('button')! };
}

beforeEach(() => {
  vi.useFakeTimers();
  registerPress.mockReset().mockReturnValue(false);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('changelog debug-recorder activator', () => {
  it('preserves normal behavior for seven presses and closes on the activating eighth press', () => {
    registerPress
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const onOpenChangelog = vi.fn();
    const { button } = renderDropdown(shared, onOpenChangelog);

    for (let index = 0; index < 7; index += 1) act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(onOpenChangelog).toHaveBeenCalledTimes(4);

    act(() => button.click());
    expect(registerPress).toHaveBeenCalledTimes(8);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(onOpenChangelog).toHaveBeenCalledTimes(4);
  });

  it('does not activate across a gap longer than four seconds', () => {
    const presses: number[] = [];
    registerPress.mockImplementation(() => {
      const now = Date.now();
      while (presses.length > 0 && now - presses[0]! > 4_000) presses.shift();
      presses.push(now);
      return presses.length >= 8;
    });
    const { button } = renderDropdown();

    for (let index = 0; index < 4; index += 1) act(() => button.click());
    act(() => vi.advanceTimersByTime(4_001));
    for (let index = 0; index < 4; index += 1) act(() => button.click());

    expect(registerPress).toHaveBeenCalledTimes(8);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it.each(['live', 'debug'])('allows activation in %s mode', (mode) => {
    registerPress.mockReturnValueOnce(true);
    const { button } = renderDropdown({ ...shared, serverInfo: { ...shared.serverInfo, mode } });
    act(() => button.click());
    expect(registerPress).toHaveBeenCalledOnce();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('always renders the megaphone but no empty dropdown body', () => {
    const { container, button } = renderDropdown({
      ...shared,
      changelogPreview: null,
      deploymentMaintenance: null,
    });
    expect(button.querySelector('.bi-megaphone')).not.toBeNull();
    act(() => button.click());
    expect(container.querySelector('[data-testid="changelog-dropdown-body"]')).toBeNull();
  });

  it('keeps maintenance content and close behavior', () => {
    const { container } = renderDropdown({
      ...shared,
      deploymentMaintenance: { id: 'deployment-1' },
      changelogPreview: null,
    });
    expect(container.textContent).toContain('Оновлення системи');
    expect(container.textContent).toContain('відбувається оновлення системи');
    expect(container.querySelector('.bi-cone-striped')).not.toBeNull();
  });
});
