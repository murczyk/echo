/**
 * @vitest-environment happy-dom
 */
import { act, forwardRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedColumnModel } from './types';
import { RerDutyNeoWorkspace } from './RerDutyNeoWorkspace';
import type { MessageFeedState } from './utils';

const renderedFeedColumns = new Map<string, FeedColumnModel>();

vi.mock('./FeedColumn', () => ({
  FeedColumn: forwardRef<HTMLDivElement, { column: FeedColumnModel }>(function FeedColumnMock(
    { column },
    ref,
  ) {
    renderedFeedColumns.set(column.feed.id, column);
    return <div ref={ref} data-testid={`feed-column-${column.feed.id}`} />;
  }),
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
      onMessageComment: () => {},
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
        onMessageComment: () => {},
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

    expect(content.querySelectorAll('[data-duty-skeleton-feed-column="true"]')).toHaveLength(3);
    expect(content.querySelectorAll('[data-duty-skeleton-feed-header="true"]')).toHaveLength(3);
  });

  it('keeps only one close action on narrow screens and exposes the create action in the active feed', async () => {
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
          isInitialLoading={false}
          messageFeeds={messageFeeds}
          narrowScreen
          onSelectFeed={() => {}}
          showLoadingBackdrop={false}
        />,
      );
    });

    expect(renderedFeedColumns.get('feed-1')?.actions.onCreateMessageFeed).toBeUndefined();
    expect(renderedFeedColumns.get('feed-2')?.actions.onCreateMessageFeed).toBeDefined();
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
  });

  it('keeps the desktop add action in the workspace rail', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const messageFeeds = [{ ...buildFeed('feed-1'), loading: false }];
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

    expect(container.querySelector('button[aria-label="Додати стрічку"]')).not.toBeNull();
    expect(container.querySelector('[data-duty-feed-create-button]')).toBeNull();
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
