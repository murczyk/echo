/**
 * @vitest-environment happy-dom
 */
import { act, createRef, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CallsignInfoRes, InboxMessage, Network } from '../../../../../Bindings';
import { FeedColumnContent, type FeedColumnContentHandle } from '../FeedColumnContent';
import { minimalInboxMessage } from '../inbox-message-mocks';
import type { FeedColumnModel, TailAvailability } from '../types';
import { emptyFilter, type MessageFeedState } from '../utils';
import { useDutyUnreadBoundaries } from '../useDutyUnreadBoundaries';

vi.mock('../useFeedIdleViewportOffload', () => ({
  useFeedIdleViewportOffload: () =>
    useMemo(
      () => ({
        mountedItemIds: null,
        placeholderHeightPx: () => 0,
        wakeFromOffload: () => {},
      }),
      [],
    ),
}));

vi.mock('../duty-scroll-debug', () => ({
  recordDutyScrollDebugEvent: () => {},
  recordDutyScrollDebugMetrics: () => {},
  recordDutyScrollDebugTiming: () => {},
  useDutyScrollDebugEnabled: () => false,
}));

const fabState = vi.hoisted(() => ({
  bottomUnreadCount: 0,
  arrowResultMessage: null as string | null,
  tailAvailability: 'unknown' as TailAvailability,
  hasUnrenderedNewerMessages: false,
  explicitNavigationLoading: false,
}));

vi.mock('../feedColumnFab', () => ({ useFeedColumnFab: () => fabState }));

const network = {
  id: 7,
  name: 'МЕРЕЖА, ЯКУ НЕ МОЖНА ПОКАЗУВАТИ',
  freqs: [],
  unitIds: [],
} as Network;

const callsignInfoMap: Record<string, CallsignInfoRes> = {
  wolf: {
    callsign: 'wolf',
    res: [
      {
        id: 1,
        callsign: 'wolf',
        position: 'КАТАЛОГОВА ПОЗИЦІЯ',
        comment: '',
        unit1: 'Каталоговий підрозділ',
        unit2: '',
        unitId: null,
        networkIdsReportedIn: [7],
      },
    ],
    networkHints: [
      {
        id: 1,
        networkId: 7,
        position: 'МЕРЕЖЕВА ПОЗИЦІЯ',
        formation: 'МЕРЕЖЕВЕ З’ЄДНАННЯ',
      },
    ],
  },
};

const message = minimalInboxMessage({
  text: 'WOLF',
  textMarked: [{ CNCallsignC: { text: 'WOLF', begin: 0, end: 4, etalon: 'WOLF' } }],
  networkIds: [7],
}) as InboxMessage;

function buildColumn(hideNetworks: boolean): FeedColumnModel {
  const feed: MessageFeedState = {
    id: 'feed-1',
    filter: emptyFilter(),
    items: [[1, message]],
    loading: false,
    loadingOlder: false,
    hasReachedStart: true,
    referenceTimeMs: null,
    readIds: new Set(),
    windowedUnreadItems: new Map(),
    unreadCount: 0,
    adjacentFreqsRange: 0,
    highlightSignalsEnabled: false,
    onlyMyUnitTagsEnabled: false,
  };
  return {
    feed,
    view: { canRemove: false, feedCount: 1, physicallyAtBottom: true },
    messageCard: {
      authUserName: null,
      copiedFeedbackId: null,
      networkDisplayMap: { 7: network.name },
      networkMap: { 7: network },
      unitsMap: {},
      callsignInfoMap,
      groupInfos: {},
      profiles: {},
      featureStrictNetworks: false,
      tagsLayout: 'compact',
      hideBotTags: false,
      hideNetworks,
      messageTextPreviewLines: 20,
      importantOnlyMyOrganism: false,
      tagsMap: {},
      tagsOrder: [],
      botTagAction: null,
      onCancelBotTagAction: () => {},
      onMarkBotTagWrong: async () => {},
    },
    actions: {
      onLoadOlder: () => {},
      onRemoveColumn: () => {},
      onMessageBookmark: () => {},
      onMessageImportant: () => {},
      onMessageCopy: () => {},
      onMessageCreateReport: () => {},
      onMessageEditReport: () => {},
      onMessageExcludeEntity: () => {},
      onMessageToggleTag: () => {},
      onMessageEdit: () => {},
    },
  } as FeedColumnModel;
}

describe('FeedColumnContent', () => {
  let container: HTMLDivElement;
  let root: Root;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    document.body.innerHTML = '';
    fabState.tailAvailability = 'unknown';
    fabState.hasUnrenderedNewerMessages = false;
    fabState.explicitNavigationLoading = false;
  });

  it('shows card group metadata only in all-groups feeds (#3727)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const column = buildColumn(false);
    column.feed.items = [[1, { ...message, groupMasterKey: 'Group Alpha', sender: 'Operator' }]];
    await act(async () => root.render(<FeedColumnContent column={column} />));
    expect(container.textContent).toContain('Group Alpha');
    expect(
      container.querySelector('[data-message-card-metadata-icon-kind="group"]'),
    ).not.toBeNull();

    await act(async () =>
      root.render(
        <FeedColumnContent
          column={{
            ...column,
            feed: {
              ...column.feed,
              filter: { ...column.feed.filter, groupsSelected: ['Group Alpha'] },
            },
          }}
        />,
      ),
    );
    expect(container.textContent).not.toContain('Group Alpha');
    expect(container.querySelector('[data-message-card-metadata-icon-kind="group"]')).toBeNull();
    expect(container.textContent).toContain('Operator');

    await act(async () => root.render(<FeedColumnContent column={column} />));
    expect(container.textContent).toContain('Group Alpha');
  });

  it('shows only marks of my organism when the setting is on, without a refetch (#4073)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onMessageImportant = vi.fn();
    const column = buildColumn(false);
    column.actions.onMessageImportant = onMessageImportant;
    column.feed.items = [
      [1, { ...message, important: true, aiImportant: true, importantByMyOrganism: false }],
      [2, { ...message, important: true, importantByMyOrganism: true }],
    ];
    const withSetting = (importantOnlyMyOrganism: boolean): FeedColumnModel => ({
      ...column,
      messageCard: { ...column.messageCard, importantOnlyMyOrganism },
    });
    const statusOf = (id: number) =>
      container.querySelector(
        `[data-duty-message-id="${id}"] [data-message-card-important-status]`,
      );

    await act(async () => root.render(<FeedColumnContent column={withSetting(false)} />));
    expect(statusOf(1)).not.toBeNull();
    expect(statusOf(2)).not.toBeNull();

    await act(async () => root.render(<FeedColumnContent column={withSetting(true)} />));
    expect(statusOf(1)).toBeNull();
    expect(statusOf(2)).not.toBeNull();
    const importantButton = container.querySelector<HTMLButtonElement>(
      '[data-duty-message-id="1"] [aria-label="Позначити як важливе"]',
    );
    expect(importantButton?.getAttribute('aria-pressed')).toBe('false');
    await act(async () => importantButton?.click());
    expect(onMessageImportant).toHaveBeenCalledWith(1, false, true);
  });

  it('keeps the first unread divider in place while reading and receiving messages (#3727)', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    function UnreadColumn({ column }: { column: FeedColumnModel }) {
      const unreadBoundaryMessageId = useDutyUnreadBoundaries([column.feed]).boundaries.get(
        column.feed.id,
      )?.messageId;
      return (
        <FeedColumnContent
          column={{ ...column, view: { ...column.view, unreadBoundaryMessageId } }}
        />
      );
    }
    const column = buildColumn(false);
    column.feed.readIds = new Set([1]);
    await act(async () => root.render(<UnreadColumn column={column} />));
    expect(container.querySelector('[data-duty-unread-divider]')).toBeNull();
    const receiving = {
      ...column,
      feed: {
        ...column.feed,
        items: [...column.feed.items, [2, message] as [number, InboxMessage]],
        unreadCount: 1,
      },
    };
    await act(async () => root.render(<UnreadColumn column={receiving} />));
    const divider = () => container.querySelector('[data-duty-unread-divider]');
    expect(divider()?.closest('[data-duty-message-id]')?.getAttribute('data-duty-message-id')).toBe(
      '2',
    );
    const reading = {
      ...receiving,
      feed: { ...receiving.feed, readIds: new Set([1, 2]), unreadCount: 0 },
    };
    await act(async () => root.render(<UnreadColumn column={reading} />));
    await act(async () =>
      root.render(
        <UnreadColumn
          column={{
            ...reading,
            feed: {
              ...reading.feed,
              items: [...reading.feed.items, [3, message]],
              unreadCount: 1,
            },
          }}
        />,
      ),
    );
    expect(container.querySelectorAll('[data-duty-unread-divider]')).toHaveLength(1);
    expect(divider()?.closest('[data-duty-message-id]')?.getAttribute('data-duty-message-id')).toBe(
      '2',
    );
    expect(container.querySelector('[data-message-feed-highlighted]')).toBeNull();
    const switching = {
      ...receiving,
      feed: {
        ...receiving.feed,
        filter: { ...receiving.feed.filter, groupsSelected: ['another-group'] },
        loading: true,
      },
    };
    await act(async () => root.render(<UnreadColumn column={switching} />));
    expect(divider()).toBeNull();
    const reloaded = {
      ...switching,
      feed: {
        ...switching.feed,
        items: [[4, message] as [number, InboxMessage]],
        readIds: new Set([4]),
        unreadCount: 0,
        loading: false,
        referenceTimeMs: 1,
      },
    };
    await act(async () => root.render(<UnreadColumn column={reloaded} />));
    expect(divider()).toBeNull();
    await act(async () =>
      root.render(
        <UnreadColumn
          column={{
            ...reloaded,
            feed: {
              ...reloaded.feed,
              items: [
                [4, message],
                [5, message],
              ],
              unreadCount: 1,
            },
          }}
        />,
      ),
    );
    expect(divider()?.closest('[data-duty-message-id]')?.getAttribute('data-duty-message-id')).toBe(
      '5',
    );
  });

  it('uses feed-owned skeleton cards for initial and available older loading', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const column = buildColumn(false);
    const initialColumn = {
      ...column,
      feed: { ...column.feed, items: [], loading: true },
    };
    await act(async () => root.render(<FeedColumnContent column={initialColumn} />));
    expect(container.querySelector('[data-message-feed-skeleton="initial"]')).not.toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();

    const olderColumn = {
      ...column,
      feed: { ...column.feed, loadingOlder: true, hasReachedStart: false },
    };
    await act(async () => root.render(<FeedColumnContent column={olderColumn} />));
    expect(container.querySelector('[data-message-feed-skeleton="above"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-message-feed-skeleton-card]')).toHaveLength(1);
    expect(container.querySelector('[data-duty-message-id="1"]')).not.toBeNull();
  });

  it('shares linked and editor highlight behavior with the Analysis feed', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const column = buildColumn(false);
    const ref = createRef<FeedColumnContentHandle>();
    await act(async () => root.render(<FeedColumnContent ref={ref} column={column} />));
    const card = container.querySelector('[data-duty-message-id="1"]');
    expect(card).not.toBeNull();

    await act(async () => {
      expect(ref.current?.highlightLinkedMessage(1)).toBe(true);
    });
    expect(card?.getAttribute('data-message-feed-highlighted')).toBe('true');

    await act(async () =>
      root.render(
        <FeedColumnContent
          ref={ref}
          column={{ ...column, view: { ...column.view, editorHighlightedMessageId: 1 } }}
        />,
      ),
    );
    expect(card?.getAttribute('data-message-feed-highlighted')).toBe('true');
  });

  it('clears a Duty link highlight after buffered newer messages become visible', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const column = buildColumn(false);
    const ref = createRef<FeedColumnContentHandle>();
    const highlighted = () => container.querySelector('[data-message-feed-highlighted]');

    await act(async () => root.render(<FeedColumnContent ref={ref} column={column} />));
    await act(async () => ref.current?.highlightLinkedMessage(1));

    const newerAvailable = {
      ...column,
      feed: { ...column.feed, evictedNewerTailId: 2 },
    };
    await act(async () =>
      root.render(
        <FeedColumnContent
          ref={ref}
          column={{
            ...newerAvailable,
            view: { ...column.view, loadingNewer: true },
          }}
        />,
      ),
    );
    await act(async () =>
      root.render(
        <FeedColumnContent
          ref={ref}
          column={{
            ...newerAvailable,
            view: { ...column.view, pendingNewerFlushNeeded: true },
          }}
        />,
      ),
    );
    expect(highlighted()?.getAttribute('data-duty-message-id')).toBe('1');

    await act(async () =>
      root.render(
        <FeedColumnContent
          ref={ref}
          column={{
            ...column,
            feed: {
              ...column.feed,
              items: [
                [1, message],
                [2, message],
              ],
            },
          }}
        />,
      ),
    );
    expect(highlighted()).toBeNull();
  });

  it('copies a Duty message link to the Duty route', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const column = buildColumn(false);
    const onMessageCopy = vi.fn();
    const messageUuid = '019a4aa8-0000-7000-8000-000000000065';
    await act(async () =>
      root.render(
        <FeedColumnContent
          column={{
            ...column,
            feed: {
              ...column.feed,
              items: [[1, minimalInboxMessage({ messageUuid, text: 'Linked message' })]],
            },
            actions: { ...column.actions, onMessageCopy },
          }}
        />,
      ),
    );

    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[title="Копіювати…"]')?.click(),
    );
    const copyLinkItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.includes('Копіювати посилання на повідомлення'));
    expect(copyLinkItem).toBeDefined();
    await act(async () => copyLinkItem?.click());

    expect(onMessageCopy).toHaveBeenCalledWith(
      `${window.location.origin}/rer-duty-neo?m=${messageUuid}`,
      'link-1',
    );
  });

  it('keeps newest navigation visible at a chunk boundary until the tail is confirmed', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const column = buildColumn(false);
    const onArrowClick = vi.fn();
    await act(async () =>
      root.render(
        <FeedColumnContent
          column={{
            ...column,
            actions: { ...column.actions, onArrowClick },
          }}
        />,
      ),
    );

    const arrow = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Завантажити нові та перейти вниз"]',
    );
    expect(arrow).not.toBeNull();
    await act(async () => arrow?.click());
    expect(onArrowClick).toHaveBeenCalledOnce();
  });

  it('keeps the lower skeleton until a buffered historical tail is rendered', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const column = buildColumn(false);
    const loaded = {
      ...column,
      feed: {
        ...column.feed,
        items: [[1, minimalInboxMessage({ createdAtOrder: 100 })]] as MessageFeedState['items'],
        historicalReadThrough: { id: 2, timestamp: 200 },
      },
    };
    await act(async () => root.render(<FeedColumnContent column={loaded} />));
    expect(container.querySelector('[data-message-feed-skeleton="below"]')).not.toBeNull();

    const buffered = {
      ...loaded,
      view: { ...loaded.view, loadingNewer: true },
      feed: {
        ...loaded.feed,
        pendingNewerItems: [
          [2, minimalInboxMessage({ createdAtOrder: 200 })],
        ] as MessageFeedState['items'],
      },
    };
    await act(async () => root.render(<FeedColumnContent column={buffered} />));
    expect(container.querySelector('[data-message-feed-skeleton="below"]')).not.toBeNull();
  });

  it('keeps newest navigation visible during a pending newer load even with a stale exhausted status', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fabState.tailAvailability = 'exhausted';
    const column = buildColumn(false);
    await act(async () =>
      root.render(
        <FeedColumnContent
          column={{
            ...column,
            view: { ...column.view, loadingNewer: true },
            actions: { ...column.actions, onArrowClick: () => {} },
          }}
        />,
      ),
    );

    const arrow = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Завантажити нові та перейти вниз"]',
    );
    expect(arrow).not.toBeNull();
    expect(arrow?.disabled).toBe(true);
    expect(arrow?.querySelector('[role="progressbar"]')).toBeNull();
    expect(arrow?.querySelector('svg[data-testid="ArrowDownwardIcon"]')).not.toBeNull();
  });

  it('shows progress on the newest button for an explicit jump', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fabState.explicitNavigationLoading = true;
    const column = buildColumn(false);
    await act(async () =>
      root.render(
        <FeedColumnContent
          column={{
            ...column,
            view: { ...column.view, loadingNewer: true },
            actions: { ...column.actions, onArrowClick: () => {} },
          }}
        />,
      ),
    );

    const arrow = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Завантажити нові та перейти вниз"]',
    );
    expect(arrow?.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('hides newest navigation only when the loaded tail is confirmed and rendered', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fabState.tailAvailability = 'exhausted';
    const column = buildColumn(false);
    const withArrow = {
      ...column,
      actions: { ...column.actions, onArrowClick: () => {} },
    };
    const arrow = () =>
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Завантажити нові та перейти вниз"]',
      );

    await act(async () => root.render(<FeedColumnContent key="confirmed" column={withArrow} />));
    expect(arrow()).toBeNull();

    fabState.hasUnrenderedNewerMessages = true;
    await act(async () => root.render(<FeedColumnContent key="buffered" column={withArrow} />));
    expect(arrow()).not.toBeNull();
  });

  // Regression: https://github.com/echoua/echo/issues/3598
  it('updates cached callsign hints when only network visibility changes', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const column = buildColumn(false);
    const hiddenColumn = {
      ...column,
      messageCard: { ...column.messageCard, hideNetworks: true },
    };

    await act(async () => root.render(<FeedColumnContent column={column} />));
    expect(container.querySelector('[aria-label="Підказка по мережі"]')).not.toBeNull();

    await act(async () => root.render(<FeedColumnContent column={hiddenColumn} />));
    const catalogHint = container.querySelector<HTMLElement>('[aria-label="Підказка з каталогу"]');
    expect(catalogHint).not.toBeNull();
    expect(container.querySelector('[aria-label="Підказка по мережі"]')).toBeNull();

    await act(async () => {
      catalogHint?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 150));
    });
    const tooltip = document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('КАТАЛОГОВА ПОЗИЦІЯ');
    expect(tooltip?.textContent).not.toContain('МЕРЕЖЕВА ПОЗИЦІЯ');

    await act(async () => root.render(<FeedColumnContent column={column} />));
    expect(container.querySelector('[aria-label="Підказка по мережі"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Підказка з каталогу"]')).toBeNull();
  });
});
