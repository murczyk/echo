/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchInboxMessages: vi.fn(),
  getUnitActivity: vi.fn(),
}));

vi.mock('../../../services/api/inbox-messages', () => ({
  fetchInboxMessages: mocks.fetchInboxMessages,
}));
vi.mock('../../../services/api/units', () => ({
  getUnitActivity: mocks.getUnitActivity,
}));
vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: unknown }) => <div role="alert">{children}</div>,
}));
vi.mock('../../rer-network-details-neo/components/NetworkDetailsActivityChart', () => ({
  NetworkDetailsActivityChart: ({ headingId }: { headingId: string }) => (
    <div data-testid="activity-chart" aria-labelledby={headingId} />
  ),
}));

import { UnitActivityPanel, UnitInterceptionsPanel } from '../index';

function inboxItem(id: number, text: string) {
  return [
    id,
    {
      createdAt: 1_700_000_000_000,
      timestamp: 1_700_000_000_000,
      groupMasterKey: 'group',
      sender: 'Sender',
      freq: '100',
      text,
    },
  ];
}

async function render(element: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await act(async () => Promise.resolve());
  return { container, root };
}

function button(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(text),
  );
}

describe('unit admin tabs', () => {
  beforeEach(() => {
    mocks.fetchInboxMessages.mockReset();
    mocks.getUnitActivity.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows five interceptions, advances by keyset, and deduplicates pages', async () => {
    mocks.fetchInboxMessages
      .mockResolvedValueOnce({
        inboxItems: [
          inboxItem(10, 'Message 10'),
          inboxItem(9, 'Message 9'),
          inboxItem(8, 'Message 8'),
          inboxItem(7, 'Message 7'),
          inboxItem(6, 'Message 6'),
        ],
        signalGroups: [{ masterKey: 'group', name: 'Test group' }],
        pageLimit: 5,
      })
      .mockResolvedValueOnce({
        inboxItems: [inboxItem(6, 'Message 6'), inboxItem(5, 'Message 5')],
        signalGroups: [],
        pageLimit: 5,
      });
    const { container, root } = await render(<UnitInterceptionsPanel unitId={42} />);

    expect(container.textContent).toContain('Message 10');
    expect(container.textContent).toContain('Message 6');
    expect(container.textContent).not.toContain('Message 5');
    expect(mocks.fetchInboxMessages.mock.calls[0][0]).toEqual(
      expect.objectContaining({ selectedUnitIds: [42], loadLatest: true }),
    );

    await act(async () => button(container, 'Завантажити ще')?.click());
    await act(async () => Promise.resolve());

    expect(mocks.fetchInboxMessages.mock.calls[1][0]).toEqual(
      expect.objectContaining({ beforeIdNoninclusive: 6, loadLatest: false }),
    );
    expect(container.textContent).toContain('Message 5');
    expect(container.textContent?.match(/Message 6/g)).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('surfaces interception failures', async () => {
    mocks.fetchInboxMessages.mockRejectedValueOnce(new Error('Access denied'));
    const { container, root } = await render(<UnitInterceptionsPanel unitId={42} />);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Access denied');
    await act(async () => root.unmount());
  });

  it('ignores an older unit page that finishes after navigation', async () => {
    let resolveOlderPage: (value: unknown) => void = () => undefined;
    const olderPage = new Promise((resolve) => {
      resolveOlderPage = resolve;
    });
    mocks.fetchInboxMessages
      .mockResolvedValueOnce({
        inboxItems: [
          inboxItem(10, 'Message 10'),
          inboxItem(9, 'Message 9'),
          inboxItem(8, 'Message 8'),
          inboxItem(7, 'Message 7'),
          inboxItem(6, 'Message 6'),
        ],
        signalGroups: [],
        pageLimit: 5,
      })
      .mockReturnValueOnce(olderPage)
      .mockResolvedValueOnce({
        inboxItems: [inboxItem(20, 'New unit message')],
        signalGroups: [],
        pageLimit: 5,
      });
    const { container, root } = await render(<UnitInterceptionsPanel unitId={42} />);

    await act(async () => button(container, 'Завантажити ще')?.click());
    await act(async () => root.render(<UnitInterceptionsPanel unitId={43} />));
    await act(async () => Promise.resolve());
    await act(async () => {
      resolveOlderPage({
        inboxItems: [inboxItem(5, 'Stale message')],
        signalGroups: [],
        pageLimit: 5,
      });
      await olderPage;
    });

    expect(container.textContent).toContain('New unit message');
    expect(container.textContent).not.toContain('Stale message');
    await act(async () => root.unmount());
  });

  it('loads activity by the selected period and labels the chart', async () => {
    mocks.getUnitActivity.mockResolvedValue({
      buckets: [{ startedAt: 1_700_000_000_000, interceptionCount: 3 }],
    });
    const { container, root } = await render(<UnitActivityPanel unitId={42} />);

    expect(mocks.getUnitActivity.mock.calls[0].slice(0, 2)).toEqual([42, 'Day']);
    expect(
      container.querySelector('[data-testid="activity-chart"]')?.getAttribute('aria-labelledby'),
    ).toBe('unit-activity-chart-title');
    expect(document.getElementById('unit-activity-chart-title')?.textContent).toBe(
      'Активність підрозділу',
    );

    await act(async () => button(container, 'Тиждень')?.click());
    await act(async () => Promise.resolve());

    expect(mocks.getUnitActivity.mock.calls.at(-1)?.slice(0, 2)).toEqual([42, 'Week']);
    await act(async () => root.unmount());
  });
});
