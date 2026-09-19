/**
 * @vitest-environment happy-dom
 */
import { act, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const generateMessageFeedIdMock = vi.hoisted(() => vi.fn());

vi.mock('../utils', async () => {
  const actual = await vi.importActual<typeof import('../utils')>('../utils');
  return {
    ...actual,
    generateMessageFeedId: generateMessageFeedIdMock,
  };
});

import { emptyFilter, MAX_MESSAGE_FEEDS, type MessageFeedState } from '../utils';
import { useRerDutyFeedCrud } from '../useRerDutyFeedCrud';

function buildFeed(id: string): MessageFeedState {
  return {
    id,
    filter: emptyFilter(),
    items: [],
    loading: false,
    loadingOlder: false,
    hasReachedStart: false,
    referenceTimeMs: null,
    readIds: new Set<number>(),
    unreadCount: 0,
    adjacentFreqsRange: 0,
    highlightSignalsEnabled: false,
    onlyMyUnitTagsEnabled: false,
  };
}

type HarnessApi = {
  messageFeeds: MessageFeedState[];
  createMessageFeed: () => void;
  removeMessageFeed: (feedId: string) => void;
  persistedStates: MessageFeedState[][];
  reloadRequests: string[];
  removedFeedIds: string[];
};

const latest = { current: null as HarnessApi | null };

function Harness(props: { initialFeeds: MessageFeedState[] }) {
  const [messageFeeds, setMessageFeeds] = useState<MessageFeedState[]>(props.initialFeeds);
  const persistedStatesRef = useRef<MessageFeedState[][]>([]);
  const reloadRequestsRef = useRef<string[]>([]);
  const removedFeedIdsRef = useRef<string[]>([]);
  const crud = useRerDutyFeedCrud(
    messageFeeds,
    setMessageFeeds,
    (next) => {
      persistedStatesRef.current.push(next);
    },
    (feedId) => {
      reloadRequestsRef.current.push(feedId);
    },
    (feedId) => {
      removedFeedIdsRef.current.push(feedId);
    },
  );

  useEffect(() => {
    latest.current = {
      messageFeeds,
      persistedStates: persistedStatesRef.current,
      reloadRequests: reloadRequestsRef.current,
      removedFeedIds: removedFeedIdsRef.current,
      ...crud,
    };
  });

  return null;
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}
describe('useRerDutyFeedCrud', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    generateMessageFeedIdMock.mockReset();
    latest.current = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    document.body.innerHTML = '';
  });

  async function renderWithFeeds(initialFeeds: MessageFeedState[]) {
    await act(async () => {
      root.render(<Harness initialFeeds={initialFeeds} />);
    });
    await flushMicrotasks();
  }

  it.each([
    { title: 'one feed', initialCount: 1 },
    { title: 'two feeds', initialCount: 2 },
    { title: 'MAX_MESSAGE_FEEDS - 1 feeds', initialCount: MAX_MESSAGE_FEEDS - 1 },
  ])('appends exactly one feed for $title', async ({ initialCount }) => {
    generateMessageFeedIdMock.mockReturnValue('mf-generated');
    const initialFeeds = Array.from({ length: initialCount }, (_, index) =>
      buildFeed(`mf-${index}`),
    );

    await renderWithFeeds(initialFeeds);

    const before = latest.current?.messageFeeds ?? [];
    await act(async () => {
      latest.current?.createMessageFeed();
    });
    await flushMicrotasks();

    expect(latest.current?.messageFeeds).toHaveLength(initialCount + 1);
    expect(latest.current?.messageFeeds?.slice(0, initialCount)).toEqual(initialFeeds);
    initialFeeds.forEach((feed, index) => {
      expect(latest.current?.messageFeeds[index]).toBe(feed);
    });
    expect(latest.current?.messageFeeds?.[initialCount]).toEqual({
      id: 'mf-generated',
      filter: emptyFilter(),
      items: [],
      loading: true,
      loadingOlder: false,
      hasReachedStart: false,
      referenceTimeMs: null,
      readIds: new Set<number>(),
      windowedUnreadItems: new Map<number, number>(),
      unreadCount: 0,
      adjacentFreqsRange: 0,
      highlightSignalsEnabled: false,
      onlyMyUnitTagsEnabled: false,
    });
    expect(latest.current?.persistedStates).toHaveLength(1);
    expect(latest.current?.persistedStates[0]).toEqual(latest.current?.messageFeeds);
    expect(latest.current?.reloadRequests).toHaveLength(0);
    expect(latest.current?.removedFeedIds).toHaveLength(0);
    expect(latest.current?.messageFeeds).not.toBe(before);
  });

  it('keeps state unchanged at MAX_MESSAGE_FEEDS', async () => {
    generateMessageFeedIdMock.mockReturnValue('mf-generated');
    const initialFeeds = Array.from({ length: MAX_MESSAGE_FEEDS }, (_, index) =>
      buildFeed(`mf-${index}`),
    );

    await renderWithFeeds(initialFeeds);

    const before = latest.current?.messageFeeds;
    await act(async () => {
      latest.current?.createMessageFeed();
    });
    await flushMicrotasks();

    expect(latest.current?.messageFeeds).toBe(before);
    expect(latest.current?.persistedStates).toHaveLength(0);
    expect(latest.current?.reloadRequests).toHaveLength(0);
    expect(latest.current?.removedFeedIds).toHaveLength(0);
  });

  it('keeps state unchanged when the generated id already exists', async () => {
    generateMessageFeedIdMock.mockReturnValue('mf-duplicate');
    const initialFeeds = [buildFeed('mf-duplicate'), buildFeed('mf-1')];

    await renderWithFeeds(initialFeeds);

    const before = latest.current?.messageFeeds;
    await act(async () => {
      latest.current?.createMessageFeed();
    });
    await flushMicrotasks();

    expect(latest.current?.messageFeeds).toBe(before);
    expect(latest.current?.persistedStates).toHaveLength(0);
    expect(latest.current?.reloadRequests).toHaveLength(0);
    expect(latest.current?.removedFeedIds).toHaveLength(0);
  });
});
