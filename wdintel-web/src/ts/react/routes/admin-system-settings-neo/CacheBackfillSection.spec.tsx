/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  status: vi.fn(),
}));

vi.mock('../../services/api/cache-backfill', () => ({
  startGroupStatsCacheBackfill: mocks.start,
}));
vi.mock('../../services/api/bgtask', () => ({
  fetchBgtaskStatusAndLogs: mocks.status,
  getBgtaskProgressFromPercent: (_logs: string[], progress?: number) => ({
    curr: progress ?? 0,
    overall: 100,
  }),
}));
vi.mock('../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: unknown }) => <div role="alert">{children}</div>,
}));
vi.mock('../../components/PowerButton', () => ({
  PowerButton: ({
    children,
    onClick,
    disabled,
  }: {
    children: unknown;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { CacheBackfillSection } from './CacheBackfillSection';

describe('CacheBackfillSection', () => {
  beforeEach(() => {
    mocks.start.mockReset();
    mocks.status.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('starts the task and renders its terminal output', async () => {
    mocks.start.mockResolvedValue(42);
    mocks.status.mockResolvedValue({
      running: false,
      loglines: ['[1/1] 2026-07-30', 'Готово. Кеш статистики перераховано.'],
      finishedWithError: null,
      progress: 100,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<CacheBackfillSection />));

    const startButton = Array.from(container.querySelectorAll('button')).find((item) =>
      item.textContent?.includes('запустити перерахунок'),
    );
    await act(async () => startButton?.click());
    await act(async () => Promise.resolve());
    await act(async () => Promise.resolve());

    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.status).toHaveBeenCalledWith(42, 0);
    expect(container.querySelector('pre')?.textContent).toContain('[1/1] 2026-07-30');
    expect(container.textContent).toContain('100%');
    await act(async () => root.unmount());
  });
});
