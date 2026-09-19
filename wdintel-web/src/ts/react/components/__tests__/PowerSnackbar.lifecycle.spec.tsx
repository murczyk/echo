/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  POWER_SNACKBAR_DEFAULT_DURATION_MS,
  PowerSnackbarProvider,
  usePowerSnackbar,
} from '../PowerSnackbar.tsx';
import {
  consumeExitFallback,
  releaseExitFallback,
  replaceExitFallback,
  type ExitFallback,
} from '../power-snackbar-exit-ownership.ts';

function NotificationHarness() {
  const { notify } = usePowerSnackbar();
  return (
    <>
      {(['success', 'info', 'warning', 'error'] as const).map((severity) => (
        <button
          key={severity}
          type="button"
          onClick={() => notify({ message: severity, severity })}
        >
          {severity}
        </button>
      ))}
      <button
        type="button"
        onClick={() => notify({ message: 'override', severity: 'success', durationMs: 50 })}
      >
        override
      </button>
    </>
  );
}

function OutsideProviderProbe() {
  try {
    usePowerSnackbar();
    return <div>no error</div>;
  } catch (error) {
    return <div>{error instanceof Error ? error.message : String(error)}</div>;
  }
}
describe('PowerSnackbarProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it.each([
    ['success', 'status'],
    ['info', 'status'],
    ['warning', 'alert'],
    ['error', 'alert'],
  ] as const)('renders %s with role %s and an accessible close action', async (severity, role) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <PowerSnackbarProvider>
          <NotificationHarness />
        </PowerSnackbarProvider>,
      ),
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          `button:nth-of-type(${['success', 'info', 'warning', 'error'].indexOf(severity) + 1})`,
        )
        ?.click();
    });

    expect(document.body.querySelector(`[role="${role}"]`)?.textContent).toContain(severity);
    expect(document.body.querySelector('button[aria-label="Закрити сповіщення"]')).not.toBeNull();
    expect(container.querySelector('[role]')).toBeNull();
    await act(async () => root.unmount());
  });

  it('uses the documented default duration for each severity', () => {
    expect(POWER_SNACKBAR_DEFAULT_DURATION_MS).toEqual({
      success: 3000,
      info: 5000,
      warning: 8000,
      error: 10000,
    });
  });

  it.each([
    ['success', 3000],
    ['info', 5000],
    ['warning', 8000],
    ['error', 10000],
  ] as const)('dismisses %s at its default duration', async (severity, duration) => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <PowerSnackbarProvider>
          <NotificationHarness />
        </PowerSnackbarProvider>,
      );
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === severity)
        ?.click();
    });

    const role = severity === 'success' || severity === 'info' ? 'status' : 'alert';
    expect(document.body.querySelector(`[role="${role}"]`)?.textContent).toContain(severity);
    await act(async () => vi.advanceTimersByTimeAsync(duration - 1));
    expect(document.body.querySelector(`[role="${role}"]`)?.textContent).toContain(severity);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(document.body.querySelector(`[role="${role}"]`)?.textContent).toContain(severity);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(document.body.querySelector(`[role="${role}"]`)).toBeNull();
    await act(async () => root.unmount());
  });

  it('keeps warning and error entries in FIFO order', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <PowerSnackbarProvider>
          <NotificationHarness />
        </PowerSnackbarProvider>,
      ),
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button:nth-of-type(3)')?.click();
      container.querySelector<HTMLButtonElement>('button:nth-of-type(4)')?.click();
    });
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('warning');
    await act(async () => vi.advanceTimersByTimeAsync(8000 + 300));
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('error');
    await act(async () => root.unmount());
  });

  it('dismisses the current notification with the close button', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <PowerSnackbarProvider>
          <NotificationHarness />
        </PowerSnackbarProvider>,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Закрити сповіщення"]')?.click(),
    );
    expect(document.body.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(document.body.querySelector('[role="status"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it('dismisses the current notification with Escape', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <PowerSnackbarProvider>
          <NotificationHarness />
        </PowerSnackbarProvider>,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(document.body.querySelector('[role="status"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it('preserves B and advances to C after a stale A exit callback', () => {
    vi.useFakeTimers();
    let currentId = 1;
    let ownership: ExitFallback | null = null;
    const timerA = setTimeout(() => {
      if (ownership?.notificationId !== 1) return;
      ownership = consumeExitFallback(ownership, 1);
      currentId = 2;
    }, 300);
    ownership = replaceExitFallback(ownership, 1, timerA);
    vi.advanceTimersByTime(300);

    const timerB = setTimeout(() => {
      if (ownership?.notificationId !== 2) return;
      ownership = consumeExitFallback(ownership, 2);
      currentId = 3;
    }, 300);
    ownership = replaceExitFallback(ownership, 2, timerB);

    ownership = releaseExitFallback(ownership, 1);
    expect(currentId).toBe(2);
    expect(ownership?.notificationId).toBe(2);

    vi.advanceTimersByTime(300);
    expect(currentId).toBe(3);
    expect(ownership).toBeNull();
  });

  it('ignores clickaway, supports duration overrides, and describes provider misuse', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <PowerSnackbarProvider>
          <NotificationHarness />
        </PowerSnackbarProvider>,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button:nth-of-type(5)')?.click(),
    );
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('override');
    await act(async () => vi.advanceTimersByTimeAsync(49));
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('override');
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('override');
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(document.body.querySelector('[role="status"]')).toBeNull();

    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const outsideRoot = createRoot(outside);
    await act(async () => outsideRoot.render(<OutsideProviderProbe />));
    expect(outside.textContent).toContain(
      'usePowerSnackbar must be used within a PowerSnackbarProvider',
    );
    await act(async () => outsideRoot.unmount());
    await act(async () => root.unmount());
  });

  it('cleans active and queued notifications when unmounted', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <PowerSnackbarProvider>
          <NotificationHarness />
        </PowerSnackbarProvider>,
      ),
    );
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button:nth-of-type(1)')?.click();
      container.querySelector<HTMLButtonElement>('button:nth-of-type(2)')?.click();
      container.querySelector<HTMLButtonElement>('button:nth-of-type(3)')?.click();
    });
    const timerBaseline = vi.getTimerCount();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Закрити сповіщення"]')?.click();
    });
    expect(vi.getTimerCount()).toBeGreaterThan(timerBaseline);
    await act(async () => {});
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(timerBaseline);
    expect(document.body.querySelector('.MuiSnackbar-root')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(document.body.querySelector('.MuiSnackbar-root')).toBeNull();
  });

  it('uses safe-area-aware bottom-right insets', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <PowerSnackbarProvider bottomInset={47} rightInset={59}>
          <NotificationHarness />
        </PowerSnackbarProvider>,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());

    const snackbar = document.body.querySelector<HTMLElement>('.MuiSnackbar-root');
    expect(snackbar).not.toBeNull();
    const generatedStyles = Array.from(document.head.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n');
    expect(generatedStyles).toContain('calc(47px + env(safe-area-inset-bottom, 0px))');
    expect(generatedStyles).toContain('calc(59px + env(safe-area-inset-right, 0px))');
    await act(async () => root.unmount());
  });

  it('uses safe-area-aware responsive defaults when insets are omitted', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <PowerSnackbarProvider>
          <NotificationHarness />
        </PowerSnackbarProvider>,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());

    const generatedStyles = Array.from(document.head.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n');
    expect(generatedStyles).toContain('calc(8px + env(safe-area-inset-bottom, 0px))');
    expect(generatedStyles).toContain('calc(24px + env(safe-area-inset-bottom, 0px))');
    expect(generatedStyles).toContain('calc(8px + env(safe-area-inset-right, 0px))');
    expect(generatedStyles).toContain('calc(24px + env(safe-area-inset-right, 0px))');
    await act(async () => root.unmount());
  });

  it('caps notification width and wraps long text without hiding the close action', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const message = 'unbroken-notification-text'.repeat(80);
    function LongNotificationHarness() {
      const { notify } = usePowerSnackbar();
      return <button type="button" onClick={() => notify({ severity: 'error', message })} />;
    }

    await act(async () =>
      root.render(
        <PowerSnackbarProvider>
          <LongNotificationHarness />
        </PowerSnackbarProvider>,
      ),
    );
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());

    expect(document.body.querySelector('button[aria-label="Закрити сповіщення"]')).not.toBeNull();
    const generatedStyles = Array.from(document.head.querySelectorAll('style'))
      .map((style) => style.textContent ?? '')
      .join('\n');
    expect(generatedStyles).toContain('min(520px');
    expect(generatedStyles).toContain('overflow-wrap:anywhere');
    await act(async () => root.unmount());
  });

  it('does not rerender hook consumers when queue state changes', async () => {
    vi.useFakeTimers();
    let renders = 0;
    function Consumer() {
      const { notify } = usePowerSnackbar();
      renders += 1;
      return (
        <button type="button" onClick={() => notify({ severity: 'success', message: 'saved' })}>
          notify
        </button>
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <PowerSnackbarProvider>
          <Consumer />
        </PowerSnackbarProvider>,
      ),
    );
    expect(renders).toBe(1);
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
    expect(renders).toBe(1);
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Закрити сповіщення"]')?.click(),
    );
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(renders).toBe(1);
    await act(async () => root.unmount());
  });
});
