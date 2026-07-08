/**
 * @vitest-environment happy-dom
 */
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { FeedColumnModel } from './types';
import { RerDutyNeoWorkspace } from './RerDutyNeoWorkspace';
import type { MessageFeedState } from './utils';

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

describe('RerDutyNeoWorkspace', () => {
  let container: HTMLElement;
  let root: Root;

  afterEach(() => {
    act(() => {
      root?.unmount();
      container?.remove();
      document.body.innerHTML = '';
    });
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
});
