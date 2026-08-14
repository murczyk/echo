/**
 * @vitest-environment happy-dom
 */
import { act, forwardRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedColumnModel } from './types';
import { RerDutyNeoWorkspace } from './RerDutyNeoWorkspace';
import type { MessageFeedState } from './utils';
import { MAX_MESSAGE_FEEDS } from './utils';

const renderedFeedColumns = new Map<string, FeedColumnModel>();
const createMessageFabPropsHistory = vi.hoisted(
  () => [] as Array<{ onClick?: () => void; rightInset?: number }>,
);

vi.mock('./FeedColumn', () => ({
  FeedColumn: forwardRef<HTMLDivElement, { column: FeedColumnModel }>(function FeedColumnMock(
    { column },
    ref,
  ) {
    renderedFeedColumns.set(column.feed.id, column);
    return <div ref={ref} data-testid={`feed-column-${column.feed.id}`} />;
  }),
}));

vi.mock('../shared/manage-message/CreateMessageFab', () => ({
  CreateMessageFab: ({ onClick, rightInset }: { onClick: () => void; rightInset?: number }) => {
    createMessageFabPropsHistory.push({ onClick, rightInset });
    return <button type="button" aria-label="Додати повідомлення" onClick={onClick} />;
  },
}));

function buildFeed(id: string): MessageFeedState {
  return {
    id,
    filter: {
      groupsSelected: null,
      groupsDenied: null,
      sendersSelected: null,
      deniedSenders: null,
      freqsSelected: null,
      freqsDenied: null,
      postsSelected: null,
      postsDenied: null,
      unitsSelected: null,
      unitsDenied: null,
      unitsExactMatchOnly: false,
      lastViewedMessageId: null,
      highlightKeywordsEnabled: false,
      highlightKeywordSetId: null,
    },
    items: [],
    loading: true,
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

function buildFeedColumnModel(feed: MessageFeedState): FeedColumnModel {
  return {
    feed,
    view: {
      narrowScreen: false,
      feedCount: 1,
      canRemove: false,
      maxWidth: '100%',
      isWatchMode: false,
      loadingNewer: false,
      arrowResultMessage: null,
      unreadCount: 0,
    },
    filterPanel: {
      feedId: feed.id,
      filterState: {
        groupsSelected: [],
        deniedGroups: [],
        sendersSelected: [],
        deniedSenders: [],
        freqsSelected: [],
        freqsDenied: [],
        postsSelected: [],
        postsDenied: [],
      },
      sources: {
        groupsList: [],
        groupInfos: {},
        profiles: {},
        senderOptions: [],
        freqs: [],
        postsList: [],
      },
      toggles: {
        adjacentFreqsRange: 0,
        highlightSignalsEnabled: false,
        onlyMyUnitTagsEnabled: false,
        reloadFreqsLoading: false,
      },
      savedFilters: {
        savedFilters: [],
        selectedSavedId: null,
        saveFilterName: '',
      },
      actions: {
        onGroupsChange: () => {},
        onDeniedGroupsChange: () => {},
        onSendersChange: () => {},
        onDeniedSendersChange: () => {},
        onFreqsChange: () => {},
        onFreqsDeniedChange: () => {},
        onPostsChange: () => {},
        onPostsDeniedChange: () => {},
        onAdjacentFreqsRangeChange: () => {},
        onHighlightSignalsChange: () => {},
        onOnlyMyUnitTagsChange: () => {},
        onReloadFreqs: () => {},
        onSavedFilterSelect: () => {},
        onSaveFilterNameChange: () => {},
        onSaveFilter: async () => true,
        onUpdateSelectedSavedFilter: async () => {},
        onRenameSelectedSavedFilter: async () => true,
        onDeleteSelectedSavedFilter: async () => {},
        onApplySavedFilter: () => {},
      },
    },
    keywordsPanel: {
      keywordSets: [],
      onFilterChange: () => {},
      onKeywordSetsReload: async () => {},
    },
    messageCard: {
      authUserName: null,
      copiedFeedbackId: null,
      networkDisplayMap: {},
      networkMap: {},
      unitsMap: {},
      callsignInfoMap: {},
      groupInfos: {},
      profiles: {},
      featureStrictNetworks: false,
      tagsLayout: 'compact',
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
      onMessageAddFrequencyToFilter: () => {},
      onMessageCopy: () => {},
      onMessageCreateReport: () => {},
      onMessageEditReport: () => {},
      onMessageExcludeEntity: () => {},
      onMessageToggleTag: () => {},
    },
  };
}

describe('RerDutyNeoWorkspace', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    renderedFeedColumns.clear();
    createMessageFabPropsHistory.splice(0);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
      container?.remove();
      document.body.innerHTML = '';
    });
    renderedFeedColumns.clear();
  });

  it('renders the initial loading header per feed instead of a shared top toolbar', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const messageFeeds = [buildFeed('feed-1'), buildFeed('feed-2'), buildFeed('feed-3')];
    const feedColumnModel = {
      feed: buildFeed('feed-1'),
      view: {
        narrowScreen: false,
        feedCount: 3,
        canRemove: false,
        maxWidth: '100%',
        isWatchMode: false,
        loadingNewer: false,
        arrowResultMessage: null,
        unreadCount: 0,
      },
      filterPanel: {
        feedId: 'feed-1',
        filterState: {
          groupsSelected: [],
          deniedGroups: [],
          sendersSelected: [],
          deniedSenders: [],
          freqsSelected: [],
          freqsDenied: [],
          postsSelected: [],
          postsDenied: [],
        },
        sources: {
          groupsList: [],
          groupInfos: {},
          profiles: {},
          senderOptions: [],
          freqs: [],
          postsList: [],
        },
        toggles: {
          adjacentFreqsRange: 0,
          highlightSignalsEnabled: false,
          onlyMyUnitTagsEnabled: false,
          reloadFreqsLoading: false,
        },
        savedFilters: {
          savedFilters: [],
          selectedSavedId: null,
          saveFilterName: '',
        },
        actions: {
          onGroupsChange: () => {},
          onDeniedGroupsChange: () => {},
          onSendersChange: () => {},
          onDeniedSendersChange: () => {},
          onFreqsChange: () => {},
          onFreqsDeniedChange: () => {},
          onPostsChange: () => {},
          onPostsDeniedChange: () => {},
          onAdjacentFreqsRangeChange: () => {},
          onHighlightSignalsChange: () => {},
          onOnlyMyUnitTagsChange: () => {},
          onReloadFreqs: () => {},
          onSavedFilterSelect: () => {},
          onSaveFilterNameChange: () => {},
          onSaveFilter: async () => true,
          onUpdateSelectedSavedFilter: async () => {},
          onRenameSelectedSavedFilter: async () => true,
          onDeleteSelectedSavedFilter: async () => {},
          onApplySavedFilter: () => {},
        },
      },
      keywordsPanel: {
        keywordSets: [],
        onFilterChange: () => {},
        onKeywordSetsReload: async () => {},
      },
      messageCard: {
        authUserName: null,
        copiedFeedbackId: null,
        networkDisplayMap: {},
        networkMap: {},
        unitsMap: {},
        callsignInfoMap: {},
        groupInfos: {},
        profiles: {},
        featureStrictNetworks: false,
        tagsLayout: 'compact',
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
        onMessageAddFrequencyToFilter: () => {},
        onMessageCopy: () => {},
        onMessageCreateReport: () => {},
        onMessageEditReport: () => {},
        onMessageExcludeEntity: () => {},
        onMessageToggleTag: () => {},
      },
    } satisfies FeedColumnModel;
    const columnRefsRef = { current: {} as Record<string, null> };

    await act(async () => {
      root.render(
        <RerDutyNeoWorkspace
          activeFeedId={null}
          buildFeedColumnModel={() => feedColumnModel}
          columnRefsRef={columnRefsRef}
          createMessageFeed={() => {}}
          openCreateMessageComposer={() => {}}
          isInitialLoading
          messageFeeds={messageFeeds}
          narrowScreen={false}
          onSelectFeed={() => {}}
          showLoadingBackdrop={false}
        />,
      );
    });

    const outer = container.firstElementChild as HTMLElement;
    const loadingRoot = outer.firstElementChild as HTMLElement;
    const content = loadingRoot.firstElementChild as HTMLElement;
    expect(content.children).toHaveLength(1);

    const skeletonHeaders = content.querySelectorAll('[data-duty-skeleton-feed-header="true"]');
    expect(content.querySelectorAll('[data-duty-skeleton-feed-column="true"]')).toHaveLength(3);
    expect(skeletonHeaders).toHaveLength(3);
    expect(content.querySelectorAll('[data-duty-skeleton-feed-toolbar-row]')).toHaveLength(3);
    expect(content.querySelectorAll('[data-duty-skeleton-feed-header-controls]')).toHaveLength(3);
    expect(
      content.querySelectorAll('[data-duty-skeleton-feed-header-section="filters"]'),
    ).toHaveLength(3);
    expect(content.querySelectorAll('[data-duty-skeleton-add-feed]')).toHaveLength(1);
    expect(content.querySelectorAll('[data-duty-skeleton-close-feed]')).toHaveLength(3);
    expect(
      Array.from(
        skeletonHeaders[0]?.querySelectorAll('[data-duty-skeleton-feed-header-section]') ?? [],
      ).map((section) => section.getAttribute('data-duty-skeleton-feed-header-section')),
    ).toEqual(['filters', 'notifications', 'highlighting']);
    expect(skeletonHeaders[2]?.querySelector('[data-duty-skeleton-add-feed]')).not.toBeNull();
    expect(skeletonHeaders[2]?.querySelector('[data-duty-skeleton-close-feed]')).not.toBeNull();
    expect(
      skeletonHeaders[2]?.querySelector('[data-duty-skeleton-action-placeholder="add"]'),
    ).not.toBeNull();
    expect(
      skeletonHeaders[2]?.querySelector('[data-duty-skeleton-action-placeholder="close"]'),
    ).not.toBeNull();

    await act(async () => {
      root.render(
        <RerDutyNeoWorkspace
          activeFeedId={null}
          buildFeedColumnModel={() => feedColumnModel}
          columnRefsRef={columnRefsRef}
          createMessageFeed={() => {}}
          openCreateMessageComposer={() => {}}
          isInitialLoading
          messageFeeds={[buildFeed('feed-1')]}
          narrowScreen={false}
          onSelectFeed={() => {}}
          showLoadingBackdrop={false}
        />,
      );
    });

    const oneFeedContent = (container.firstElementChild?.firstElementChild?.firstElementChild ??
      null) as HTMLElement;
    expect(oneFeedContent.querySelectorAll('[data-duty-skeleton-feed-header]')).toHaveLength(1);
    expect(oneFeedContent.querySelectorAll('[data-duty-skeleton-add-feed]')).toHaveLength(1);
    expect(oneFeedContent.querySelectorAll('[data-duty-skeleton-close-feed]')).toHaveLength(0);

    await act(async () => {
      root.render(
        <RerDutyNeoWorkspace
          activeFeedId={null}
          buildFeedColumnModel={() => feedColumnModel}
          columnRefsRef={columnRefsRef}
          createMessageFeed={() => {}}
          openCreateMessageComposer={() => {}}
          isInitialLoading
          messageFeeds={Array.from({ length: MAX_MESSAGE_FEEDS }, (_, index) =>
            buildFeed(`feed-${index + 1}`),
          )}
          narrowScreen={false}
          onSelectFeed={() => {}}
          showLoadingBackdrop={false}
        />,
      );
    });

    const maxFeedContent = (container.firstElementChild?.firstElementChild?.firstElementChild ??
      null) as HTMLElement;
    expect(maxFeedContent.querySelectorAll('[data-duty-skeleton-feed-header]')).toHaveLength(
      MAX_MESSAGE_FEEDS,
    );
    expect(maxFeedContent.querySelectorAll('[data-duty-skeleton-add-feed]')).toHaveLength(0);
    expect(maxFeedContent.querySelectorAll('[data-duty-skeleton-close-feed]')).toHaveLength(
      MAX_MESSAGE_FEEDS,
    );
  });

  it('keeps only one close action on narrow screens and exposes scroll stacking on the active feed', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const messageFeeds = [
      { ...buildFeed('feed-1'), loading: false },
      { ...buildFeed('feed-2'), loading: false },
    ];
    const narrowBuildFeedColumnModel = (feed: MessageFeedState) => ({
      ...buildFeedColumnModel(feed),
      view: {
        ...buildFeedColumnModel(feed).view,
        narrowScreen: true,
        feedCount: 2,
        canRemove: true,
      },
    });
    const columnRefsRef = { current: {} as Record<string, null> };

    await act(async () => {
      root.render(
        <RerDutyNeoWorkspace
          activeFeedId="feed-2"
          buildFeedColumnModel={narrowBuildFeedColumnModel}
          columnRefsRef={columnRefsRef}
          createMessageFeed={() => {}}
          openCreateMessageComposer={vi.fn()}
          isInitialLoading={false}
          messageFeeds={messageFeeds}
          narrowScreen
          onSelectFeed={() => {}}
          showLoadingBackdrop={false}
        />,
      );
    });

    const fab = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Додати повідомлення"]',
    );
    expect(fab).not.toBeNull();
    expect(container.contains(fab)).toBe(true);
    expect(createMessageFabPropsHistory.at(-1)?.rightInset).toBe(5);
    expect(renderedFeedColumns.get('feed-1')?.view.workspaceFabAvoidance).toBe('none');
    expect(renderedFeedColumns.get('feed-2')?.view.workspaceFabAvoidance).toBe('above');
    expect(renderedFeedColumns.get('feed-2')?.view.scrollTrackingEnabled).toBe(true);
  });

  it('enables scroll tracking only for the active narrow feed and flips it on tab change', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const messageFeeds = [
      { ...buildFeed('feed-1'), loading: false },
      { ...buildFeed('feed-2'), loading: false },
    ];
    const columnRefsRef = { current: {} as Record<string, null> };

    await act(async () => {
      root.render(
        <RerDutyNeoWorkspace
          activeFeedId="feed-2"
          buildFeedColumnModel={buildFeedColumnModel}
          columnRefsRef={columnRefsRef}
          createMessageFeed={() => {}}
          isInitialLoading={false}
          messageFeeds={messageFeeds}
          narrowScreen
          onSelectFeed={() => {}}
          showLoadingBackdrop={false}
        />,
      );
    });

    expect(renderedFeedColumns.get('feed-1')?.view.scrollTrackingEnabled).toBe(false);
    expect(renderedFeedColumns.get('feed-2')?.view.scrollTrackingEnabled).toBe(true);
    expect(renderedFeedColumns.get('feed-1')?.view.workspaceFabAvoidance).toBe('none');
    expect(renderedFeedColumns.get('feed-2')?.view.workspaceFabAvoidance).toBe('above');

    await act(async () => {
      root.render(
        <RerDutyNeoWorkspace
          activeFeedId="feed-1"
          buildFeedColumnModel={buildFeedColumnModel}
          columnRefsRef={columnRefsRef}
          createMessageFeed={() => {}}
          isInitialLoading={false}
          messageFeeds={messageFeeds}
          narrowScreen
          onSelectFeed={() => {}}
          showLoadingBackdrop={false}
        />,
      );
    });

    expect(renderedFeedColumns.get('feed-1')?.view.scrollTrackingEnabled).toBe(true);
    expect(renderedFeedColumns.get('feed-2')?.view.scrollTrackingEnabled).toBe(false);
    expect(renderedFeedColumns.get('feed-1')?.view.workspaceFabAvoidance).toBe('above');
    expect(renderedFeedColumns.get('feed-2')?.view.workspaceFabAvoidance).toBe('none');
  });

  it('assigns add-feed to the last desktop header and removes it at the limit', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const columnRefsRef = { current: {} as Record<string, null> };
    const createMessageFeed = vi.fn();
    const openCreateMessageComposer = vi.fn();

    const renderWorkspace = async (feedCount: number) => {
      const messageFeeds = Array.from({ length: feedCount }, (_, index) => ({
        ...buildFeed(`feed-${index + 1}`),
        loading: false,
      }));

      await act(async () => {
        root.render(
          <RerDutyNeoWorkspace
            activeFeedId={messageFeeds[0]?.id ?? null}
            buildFeedColumnModel={(feed) => {
              const column = buildFeedColumnModel(feed);
              column.view.feedCount = messageFeeds.length;
              column.view.canRemove = messageFeeds.length > 1;
              return column;
            }}
            columnRefsRef={columnRefsRef}
            createMessageFeed={createMessageFeed}
            openCreateMessageComposer={openCreateMessageComposer}
            isInitialLoading={false}
            messageFeeds={messageFeeds}
            narrowScreen={false}
            onSelectFeed={() => {}}
            showLoadingBackdrop={false}
          />,
        );
      });
    };

    await renderWorkspace(1);
    expect(renderedFeedColumns.get('feed-1')?.view.workspaceFabAvoidance).toBe('none');
    expect(container.querySelectorAll('button[aria-label="Додати повідомлення"]')).toHaveLength(1);
    await act(async () => {
      container
        .querySelector('button[aria-label="Додати повідомлення"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(openCreateMessageComposer).toHaveBeenCalledTimes(1);
    openCreateMessageComposer.mockReset();

    await renderWorkspace(MAX_MESSAGE_FEEDS - 1);
    const workspaceBefore = container.querySelector('[data-duty-workspace-main]') as HTMLElement;
    expect(workspaceBefore.style.paddingTop).toBe('');
    expect(renderedFeedColumns.get('feed-1')?.actions.onCreateFeed).toBeUndefined();
    expect(
      renderedFeedColumns.get(`feed-${MAX_MESSAGE_FEEDS - 1}`)?.actions.onCreateFeed,
    ).toBeDefined();
    for (let index = 1; index < MAX_MESSAGE_FEEDS - 1; index += 1) {
      expect(renderedFeedColumns.get(`feed-${index}`)?.actions.onCreateFeed).toBeUndefined();
      expect(renderedFeedColumns.get(`feed-${index}`)?.view.workspaceFabAvoidance).toBe('none');
    }
    expect(
      renderedFeedColumns.get(`feed-${MAX_MESSAGE_FEEDS - 1}`)?.view.workspaceFabAvoidance,
    ).toBe('left');
    expect(
      Array.from(renderedFeedColumns.values()).every(
        (column) => !Object.prototype.hasOwnProperty.call(column.actions, 'onCreateMessage'),
      ),
    ).toBe(true);
    expect(container.querySelectorAll('button[aria-label="Додати повідомлення"]')).toHaveLength(1);
    await act(async () => {
      renderedFeedColumns.get(`feed-${MAX_MESSAGE_FEEDS - 1}`)?.actions.onCreateFeed?.();
      container
        .querySelector('button[aria-label="Додати повідомлення"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(createMessageFeed).toHaveBeenCalledTimes(1);
    expect(openCreateMessageComposer).toHaveBeenCalledTimes(1);

    createMessageFeed.mockReset();
    openCreateMessageComposer.mockReset();
    await renderWorkspace(MAX_MESSAGE_FEEDS);
    const workspaceAfter = container.querySelector('[data-duty-workspace-main]') as HTMLElement;
    expect(workspaceAfter.style.paddingTop).toBe('');
    expect(
      Array.from(renderedFeedColumns.values()).every(
        (column) => column.actions.onCreateFeed == null,
      ),
    ).toBe(true);
    expect(container.querySelector('button[aria-label="Додати стрічку"]')).toBeNull();
    for (let index = 1; index < MAX_MESSAGE_FEEDS; index += 1) {
      expect(renderedFeedColumns.get(`feed-${index}`)?.view.workspaceFabAvoidance).toBe('none');
    }
    expect(renderedFeedColumns.get(`feed-${MAX_MESSAGE_FEEDS}`)?.view.workspaceFabAvoidance).toBe(
      'left',
    );
    expect(
      Array.from(renderedFeedColumns.values()).every(
        (column) => !Object.prototype.hasOwnProperty.call(column.actions, 'onCreateMessage'),
      ),
    ).toBe(true);
    expect(container.querySelectorAll('button[aria-label="Додати повідомлення"]')).toHaveLength(1);
    await act(async () => {
      container
        .querySelector('button[aria-label="Додати повідомлення"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(workspaceAfter.style.paddingTop).toBe(workspaceBefore.style.paddingTop);
    expect(createMessageFeed).not.toHaveBeenCalled();
    expect(openCreateMessageComposer).toHaveBeenCalledTimes(1);
  });

  it('keeps scroll tracking enabled for all desktop feeds', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const messageFeeds = [
      { ...buildFeed('feed-1'), loading: false },
      { ...buildFeed('feed-2'), loading: false },
    ];
    const columnRefsRef = { current: {} as Record<string, null> };

    await act(async () => {
      root.render(
        <RerDutyNeoWorkspace
          activeFeedId="feed-1"
          buildFeedColumnModel={buildFeedColumnModel}
          columnRefsRef={columnRefsRef}
          createMessageFeed={() => {}}
          isInitialLoading={false}
          messageFeeds={messageFeeds}
          narrowScreen={false}
          onSelectFeed={() => {}}
          showLoadingBackdrop={false}
        />,
      );
    });

    expect(renderedFeedColumns.get('feed-1')?.view.scrollTrackingEnabled).toBe(true);
    expect(renderedFeedColumns.get('feed-2')?.view.scrollTrackingEnabled).toBe(true);
  });

  it('still renders the create-message FAB in narrow and desktop workspace states', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const columnRefsRef = { current: {} as Record<string, null> };
    const messageFeeds = [{ ...buildFeed('feed-1'), loading: false }];

    await act(async () => {
      root.render(
        <RerDutyNeoWorkspace
          activeFeedId="feed-1"
          buildFeedColumnModel={buildFeedColumnModel}
          columnRefsRef={columnRefsRef}
          createMessageFeed={() => {}}
          openCreateMessageComposer={() => {}}
          isInitialLoading={true}
          messageFeeds={messageFeeds}
          narrowScreen
          onSelectFeed={() => {}}
          showLoadingBackdrop={false}
        />,
      );
    });

    const narrowFab = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Додати повідомлення"]',
    );
    expect(narrowFab).not.toBeNull();
    expect(container.contains(narrowFab)).toBe(true);
    expect(createMessageFabPropsHistory.at(-1)?.rightInset).toBe(5);

    await act(async () => {
      root.render(
        <RerDutyNeoWorkspace
          activeFeedId="feed-1"
          buildFeedColumnModel={buildFeedColumnModel}
          columnRefsRef={columnRefsRef}
          createMessageFeed={() => {}}
          openCreateMessageComposer={() => {}}
          isInitialLoading={false}
          messageFeeds={messageFeeds}
          narrowScreen={false}
          onSelectFeed={() => {}}
          showLoadingBackdrop={false}
        />,
      );
    });

    const desktopFab = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Додати повідомлення"]',
    );
    expect(desktopFab).not.toBeNull();
    expect(container.contains(desktopFab)).toBe(true);
    expect(createMessageFabPropsHistory.at(-1)?.rightInset).toBe(5);
  });

  it('does not mutate the source column view when enabling scroll tracking', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const messageFeeds = [{ ...buildFeed('feed-1'), loading: false }];
    const sourceColumn = buildFeedColumnModel(messageFeeds[0]);
    const sourceView = sourceColumn.view;
    const builder = vi.fn(() => sourceColumn);
    const columnRefsRef = { current: {} as Record<string, null> };

    await act(async () => {
      root.render(
        <RerDutyNeoWorkspace
          activeFeedId="feed-1"
          buildFeedColumnModel={builder}
          columnRefsRef={columnRefsRef}
          createMessageFeed={() => {}}
          isInitialLoading={false}
          messageFeeds={messageFeeds}
          narrowScreen={false}
          onSelectFeed={() => {}}
          showLoadingBackdrop={false}
        />,
      );
    });

    expect(builder).toHaveBeenCalledTimes(1);
    expect(sourceColumn.view).toBe(sourceView);
    expect(sourceColumn.view.scrollTrackingEnabled).toBeUndefined();
    expect(renderedFeedColumns.get(messageFeeds[0].id)?.view).not.toBe(sourceView);
    expect(renderedFeedColumns.get(messageFeeds[0].id)?.view.scrollTrackingEnabled).toBe(true);
  });
});
