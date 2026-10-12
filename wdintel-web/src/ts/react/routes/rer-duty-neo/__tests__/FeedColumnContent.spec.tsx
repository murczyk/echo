/**
 * @vitest-environment happy-dom
 */
import { act, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CallsignInfoRes, InboxMessage, Network } from '../../../../../Bindings';
import { FeedColumnContent } from '../FeedColumnContent';
import { minimalInboxMessage } from '../inbox-message-mocks';
import type { FeedColumnModel, TailAvailability } from '../types';
import { emptyFilter, type MessageFeedState } from '../utils';

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
