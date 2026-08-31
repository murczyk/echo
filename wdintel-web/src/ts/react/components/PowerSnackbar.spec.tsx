/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PowerSnackbarProvider, usePowerSnackbar } from './PowerSnackbar';

function NotificationHarness() {
  const { notify } = usePowerSnackbar();
  return (
    <>
      <button type="button" onClick={() => notify({ message: 'success', severity: 'success' })}>
        success
      </button>
      <button type="button" onClick={() => notify({ message: 'info', severity: 'info' })}>
        info
      </button>
    </>
  );
}

describe('PowerSnackbarProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  // @test-scope safeguard: prevents duplicate or queued notifications from being lost or reordered
  it('queues notifications FIFO and repeats identical messages', async () => {
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
      container.querySelector<HTMLButtonElement>('button:nth-of-type(1)')?.click();
      container.querySelector<HTMLButtonElement>('button:nth-of-type(2)')?.click();
    });
    expect(document.body.querySelectorAll('[role="status"]')[0]?.textContent).toContain('success');
    expect(document.body.querySelectorAll('[role="status"]')[0]?.textContent).not.toContain('info');

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Закрити сповіщення"]')?.click();
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(document.body.querySelectorAll('[role="status"]')[0]?.textContent).toContain('success');
    expect(document.body.querySelectorAll('[role="status"]')[0]?.textContent).not.toContain('info');

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Закрити сповіщення"]')?.click();
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(
      Array.from(document.body.querySelectorAll('[role="status"]')).some((node) =>
        node.textContent?.includes('info'),
      ),
    ).toBe(true);
    await act(async () => root.unmount());
  });

  // @test-scope safeguard: prevents a queued notification from replacing the current alert before its exit completes
  it('keeps the next notification hidden until the current exit completes', async () => {
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
    });
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Закрити сповіщення"]')?.click(),
    );
    expect(document.body.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('success');
    expect(document.body.querySelector('[role="status"]')?.textContent).not.toContain('info');
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(document.body.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain('info');
    expect(document.body.querySelector('[role="status"]')?.textContent).not.toContain('success');
    await act(async () => root.unmount());
  });
});
