// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiCallsignFeedback } from '../AiCallsignFeedback';

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  list: vi
    .fn()
    .mockResolvedValue([{ callsign: 'фипка', removalCount: 3, updatedAt: 1_700_000_000_000 }]),
  details: vi.fn().mockResolvedValue([
    {
      id: 1,
      inboxItemId: 42,
      actor: 'analyst',
      body: 'В вашу сторону Фипка',
      createdAt: 1_700_000_000_000,
    },
  ]),
  runs: vi.fn().mockResolvedValue([]),
  start: vi.fn().mockResolvedValue({ id: 'run' }),
}));

vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: mocks.notify }),
}));

vi.mock('../../../services/api/ai-callsigns', () => ({
  listCallsignFeedback: mocks.list,
  getCallsignFeedback: mocks.details,
  getCallsignReparseRuns: mocks.runs,
  startCallsignReparse: mocks.start,
  cancelCallsignReparse: vi.fn(),
  retryCallsignReparse: vi.fn(),
  getCallsignReparseFailures: vi.fn(),
}));

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

async function mount(enabled = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<AiCallsignFeedback enabled={enabled} />));
  return container;
}

async function click(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(label),
  );
  expect(button).toBeTruthy();
  await act(async () => button?.click());
}

describe('callsign feedback', () => {
  // Regression: https://github.com/echoua/echo/issues/3167
  it('shows recorded evidence and launches a 14-day historical run', async () => {
    const container = await mount();
    expect(container.textContent).toContain('фипка');
    await click('фипка');
    expect(document.body.textContent).toContain('В вашу сторону Фипка');
    expect(mocks.details).toHaveBeenCalledWith({ callsign: 'фипка', beforeId: null });
    await click('Закрити');
    await click('Запустити обробку');
    expect(mocks.start).toHaveBeenCalledWith({ days: 14 });
  });

  // Regression: https://github.com/echoua/echo/issues/3167
  it('does not allow launching without the configured worker', async () => {
    await mount(false);
    await click('Запустити обробку');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  // Regression: https://github.com/echoua/echo/issues/3167
  it('reports API failures to the user', async () => {
    mocks.start.mockRejectedValueOnce(new Error('vLLM unavailable'));
    await mount();
    await click('Запустити обробку');
    expect(mocks.notify).toHaveBeenCalledWith({ severity: 'error', message: 'vLLM unavailable' });
  });
});
