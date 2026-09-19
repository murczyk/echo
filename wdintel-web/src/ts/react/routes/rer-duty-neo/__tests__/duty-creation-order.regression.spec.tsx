/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessage } from '../../../../../Bindings';
import { transformCamelToSnake } from '../../../../snake-to-camel';
import { USER_SETTINGS_UPDATED_EVENT } from '../../../services/api/user-settings';
import { useRerDutyFeeds } from '../useRerDutyFeeds';
import { minimalInboxMessage } from '../inbox-message-mocks';

type Item = [number, InboxMessage];
type Request = { path: string; body: Record<string, unknown> };
const baseTime = Date.UTC(2026, 8, 19, 8);
let root: Root;
let container: HTMLDivElement;
let feeds: ReturnType<typeof useRerDutyFeeds>;
let requests: Request[];
let items: Item[];
let older: Item[];
let newer: Item[];

function message(id: number, createdOffset: number, eventOffset: number): Item {
  return [
    id,
    minimalInboxMessage({
      createdAt: baseTime + Math.floor(createdOffset / 1000),
      createdAtOrder: baseTime * 1000 + createdOffset,
      timestamp: baseTime + eventOffset,
      text: `Message ${id}`,
    }),
  ];
}

function inboxResponse(page: Item[]) {
  return {
    inbox_items: page.map(([id, item]) => [id, transformCamelToSnake(item)]),
    poll_cursor_id: page.at(-1)?.[0] ?? null,
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
  };
}

function responseFor(path: string, body: Record<string, unknown>): unknown {
  switch (path) {
    case '/api/user/settings':
      return { messageSortBy: 'interception', disableAutoScroll: true };
    case '/api/system-settings/current':
      return { rer_duty_poll_interval_sec: 5 };
    case '/api-public/server-info':
      return {};
    case '/api/rer-importer/latest-senders':
      return { data: {} };
    case '/api/rer/analysis/stats/posts':
      return { posts: [] };
    case '/api/sigint/units':
      return { units: [], show_load_more: false };
    case '/api/rer-importer/get-inbox':
      return inboxResponse(
        body.before_id_noninclusive != null
          ? older
          : body.since_id_noninclusive != null
            ? newer
            : items,
      );
    case '/api/rer-importer/get-inbox-count':
      return { quantity: newer.length, first_element_ts: null };
    case '/api/organism/keyword-sets':
    case '/api/sigint/latest-frequencies':
    case '/api/tags/tags-list':
    case '/api/user/sigint-groups':
    case '/api/rer/duty/saved-filters':
      return [];
    default:
      throw new Error(`Unexpected request: ${path}`);
  }
}

function Harness() {
  feeds = useRerDutyFeeds('reader', null, { status: 'allowed' });
  return null;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function mount() {
  await act(async () => root.render(<Harness />));
  await settle();
  await settle();
  expect(feeds.error).toBeNull();
  expect(feeds.messageFeeds[0].loading).toBe(false);
}

function ids() {
  return feeds.messageFeeds[0].items.map(([id]) => id);
}

// @test-scope regression: https://github.com/echoua/echo/issues/3546
describe('Duty creation-time contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    requests = [];
    items = [message(9, 300, -60_000), message(7, 100, 60_000), message(2, 200, 0)];
    older = [];
    newer = [];
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        requests.push({ path, body });
        return new Response(JSON.stringify(responseFor(path, body)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    window.history.replaceState({}, '', '/rer-duty-neo');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps creation order through pagination, buffering, and Analysis preference changes', async () => {
    await mount();
    expect(ids()).toEqual([7, 2, 9]);
    expect(requests.filter(({ path }) => path.endsWith('/get-inbox'))).toHaveLength(1);

    older = [message(40, 50, 120_000)];
    await act(async () => {
      await feeds.loadFeedOlderMessages('mf-0');
    });
    expect(ids()).toEqual([40, 7, 2, 9]);
    expect(requests.at(-1)?.body.before_id_noninclusive).toBe(7);

    newer = [message(1, 500, -120_000), message(6, 400, -180_000), message(3, 400, 180_000)];
    await act(async () => {
      await feeds.loadFeedNewerMessages('mf-0');
    });
    expect(requests.at(-1)?.body.since_id_noninclusive).toBe(9);
    expect(ids()).toEqual([40, 7, 2, 9]);
    expect(feeds.messageFeeds[0].pendingNewerItems?.map(([id]) => id)).toEqual([3, 6, 1]);
    expect(feeds.messageFeeds[0].unreadCount).toBe(3);

    const retained = feeds.messageFeeds[0];
    const requestCount = requests.length;
    for (const messageSortBy of ['creation', 'interception']) {
      await act(async () =>
        window.dispatchEvent(
          new CustomEvent(USER_SETTINGS_UPDATED_EVENT, {
            detail: { messageSortBy, disableAutoScroll: true },
          }),
        ),
      );
      await settle();
      expect(feeds.messageFeeds[0]).toBe(retained);
      expect(requests).toHaveLength(requestCount);
    }

    await act(async () => {
      feeds.flushPendingNewerMessages('mf-0');
    });
    expect(ids()).toEqual([40, 7, 2, 9, 3, 6, 1]);
    expect(feeds.messageFeeds[0].unreadCount).toBe(3);
    await act(async () => {
      feeds.handleVisibleMessageIds('mf-0')(1, { atBottom: true });
    });
    expect(feeds.messageFeeds[0].unreadCount).toBe(0);

    newer = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await settle();
    expect(requests.some(({ path }) => path.endsWith('/get-inbox-count'))).toBe(true);

    for (const { body } of requests.filter(
      ({ path }) => path.endsWith('/get-inbox') || path.endsWith('/get-inbox-count'),
    )) {
      expect(body).toMatchObject({ sort_by: 'IMSCreatedAt', page_id: 'rer-duty-neo' });
    }
  });
});
