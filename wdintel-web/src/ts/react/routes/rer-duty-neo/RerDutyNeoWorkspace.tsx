import { Backdrop, Box, ButtonBase, CircularProgress, Skeleton, Tooltip } from '@mui/material';
import { isPresent } from '../../utils/misc';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, Ref, SetStateAction } from 'react';

import { FeedColumn, type FeedColumnHandle } from './FeedColumn';
import type { FeedColumnModel } from './types';
import {
  DUTY_ICON_ONLY_COLUMN_HEADER_MIN_FEEDS,
  DUTY_ICON_ONLY_FEED_TAB_MIN_FEEDS,
} from './FeedColumnHeader';
import type { MessageFeedState } from './utils';
import { MAX_MESSAGE_FEEDS } from './utils';
import { CreateMessageFab } from '../shared/manage-message/CreateMessageFab';
import { DUTY_WORKSPACE_CREATE_MESSAGE_RIGHT_INSET } from '../shared/manage-message/floating-control-geometry';
import { useObservedWidth } from '../../hooks/use-observed-width';
import { shouldUseActiveFeedLayout } from './duty-editor-layout';
import { MessageFeedSkeletons, type AnchorSnapshot } from '../shared/message-feed';

function dutyFeedColumnMaxWidth(feedCount: number, narrow: boolean): string {
  if (narrow) return '100%';
  if (feedCount <= 1) return '960px';
  return '100%';
}

function DutyNeoInitialLoadingSkeletonFeedHeader({
  feedCount,
  isRightmost,
  canAddFeed,
  canCloseFeed,
}: {
  feedCount: number;
  isRightmost: boolean;
  canAddFeed: boolean;
  canCloseFeed: boolean;
}) {
  const iconOnly = feedCount >= DUTY_ICON_ONLY_COLUMN_HEADER_MIN_FEEDS;

  return (
    <Box
      data-duty-skeleton-feed-header="true"
      sx={{
        display: 'flex',
        alignItems: 'stretch',
        flexShrink: 0,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 0,
        backgroundColor: 'background.paper',
      }}
    >
      <Box
        data-duty-skeleton-feed-toolbar-row
        sx={{
          display: 'flex',
          alignItems: 'stretch',
          height: 32,
          minHeight: 32,
          width: '100%',
          minWidth: 0,
        }}
      >
        <Box
          data-duty-skeleton-feed-header-controls
          sx={{ display: 'flex', flex: '1 1 auto', minWidth: 0, overflow: 'hidden' }}
        >
          {['filters', 'notifications', 'highlighting'].map((section, index) => (
            <Box
              key={section}
              data-duty-skeleton-feed-header-section={section}
              sx={{
                display: 'flex',
                flex: '1 1 0',
                minWidth: 0,
                alignItems: 'center',
                justifyContent: 'center',
                ...(index > 0 ? { borderLeft: '1px solid', borderLeftColor: 'divider' } : {}),
              }}
            >
              <Skeleton
                variant="rectangular"
                width={iconOnly ? 20 : '70%'}
                height={iconOnly ? 20 : 18}
              />
            </Box>
          ))}
        </Box>
        <Box
          data-duty-skeleton-feed-header-actions
          sx={{ display: 'flex', flexShrink: 0, minWidth: 0 }}
        >
          {isRightmost && canAddFeed ? (
            <Box
              data-duty-skeleton-add-feed
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                borderLeft: '1px solid',
                borderLeftColor: 'divider',
              }}
            >
              <Skeleton
                data-duty-skeleton-action-placeholder="add"
                variant="rectangular"
                width={20}
                height={20}
              />
            </Box>
          ) : null}
          {canCloseFeed ? (
            <Box
              data-duty-skeleton-close-feed
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                borderLeft: '1px solid',
                borderLeftColor: 'divider',
              }}
            >
              <Skeleton
                data-duty-skeleton-action-placeholder="close"
                variant="rectangular"
                width={20}
                height={20}
              />
            </Box>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}

function DutyNeoInitialLoadingSkeletonFeedColumn({
  messageCount,
  feedCount,
  isRightmost,
  canAddFeed,
  canCloseFeed,
}: {
  messageCount: number;
  feedCount: number;
  isRightmost: boolean;
  canAddFeed: boolean;
  canCloseFeed: boolean;
}) {
  return (
    <Box
      data-duty-skeleton-feed-column="true"
      sx={{
        display: 'flex',
        minWidth: 0,
        minHeight: 0,
        flexDirection: 'column',
        height: '100%',
        flex: 1,
        gap: 1.5,
        p: 1.5,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        backgroundColor: 'background.paper',
      }}
    >
      <DutyNeoInitialLoadingSkeletonFeedHeader
        feedCount={feedCount}
        isRightmost={isRightmost}
        canAddFeed={canAddFeed}
        canCloseFeed={canCloseFeed}
      />
      <MessageFeedSkeletons count={messageCount} />
    </Box>
  );
}

function DutyNeoInitialLoadingSkeleton({
  feedCount,
  narrow,
}: {
  feedCount: number;
  narrow: boolean;
}) {
  const skeletonFeedCount = narrow ? 1 : Math.max(1, feedCount);
  const skeletonMaxWidth = dutyFeedColumnMaxWidth(skeletonFeedCount, narrow);
  const skeletonMessageCount = narrow ? 4 : 5;
  return (
    <Box className="flex flex-1 min-h-0 h-full w-full overflow-hidden">
      <Box
        className="flex flex-1 min-w-0 min-h-0 h-full flex-col"
        sx={{
          width: '100%',
          maxWidth: skeletonMaxWidth,
          mx: 'auto',
        }}
      >
        <Box
          className="w-full min-h-0 h-full overflow-hidden"
          sx={{
            display: 'grid',
            flex: 1,
            minHeight: 0,
            alignItems: 'stretch',
            gap: 2,
            height: '100%',
            gridTemplateColumns:
              skeletonFeedCount <= 1
                ? 'minmax(0, 1fr)'
                : `repeat(${skeletonFeedCount}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: skeletonFeedCount }).map((_, index) => (
            <DutyNeoInitialLoadingSkeletonFeedColumn
              key={index}
              messageCount={skeletonMessageCount}
              feedCount={feedCount}
              isRightmost={index === skeletonFeedCount - 1}
              canAddFeed={feedCount < MAX_MESSAGE_FEEDS}
              canCloseFeed={feedCount > 1}
            />
          ))}
        </Box>
      </Box>
    </Box>
  );
}

type RerDutyNeoWorkspaceProps = {
  activeFeedId: string | null;
  buildFeedColumnModel: (feed: MessageFeedState) => FeedColumnModel;
  columnRefsRef: MutableRefObject<Record<string, FeedColumnHandle | null>>;
  createMessageFeed: () => void;
  createMessageFabRef?: Ref<HTMLButtonElement>;
  openCreateMessageComposer: () => void;
  isInitialLoading: boolean;
  messageFeeds: MessageFeedState[];
  narrowScreen: boolean;
  onSelectFeed: Dispatch<SetStateAction<string | null>>;
  showLoadingBackdrop: boolean;
  editorOpen?: boolean;
  editorEmbeddedOpen?: boolean;
};

export function RerDutyNeoWorkspace({
  activeFeedId,
  buildFeedColumnModel,
  columnRefsRef,
  createMessageFeed,
  createMessageFabRef,
  openCreateMessageComposer,
  isInitialLoading,
  messageFeeds,
  narrowScreen,
  onSelectFeed,
  showLoadingBackdrop,
  editorOpen = false,
  editorEmbeddedOpen = false,
}: RerDutyNeoWorkspaceProps) {
  const { ref: workspaceRef, width: availableWidth } = useObservedWidth<HTMLDivElement>();
  const [feedsWithOpenPanels, setFeedsWithOpenPanels] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const feedScrollAnchorsRef = useRef(new Map<string, AnchorSnapshot>());
  const handleScrollAnchorSnapshotChange = useCallback(
    (feedId: string, snapshot: AnchorSnapshot | null) => {
      if (snapshot) feedScrollAnchorsRef.current.set(feedId, snapshot);
      else feedScrollAnchorsRef.current.delete(feedId);
    },
    [],
  );
  useEffect(() => {
    const activeFeedIds = new Set(messageFeeds.map((feed) => feed.id));
    for (const feedId of feedScrollAnchorsRef.current.keys()) {
      if (!activeFeedIds.has(feedId)) feedScrollAnchorsRef.current.delete(feedId);
    }
  }, [messageFeeds]);
  const handlePanelOpenChange = useCallback((feedId: string, panelOpen: boolean) => {
    setFeedsWithOpenPanels((current) => {
      if (current.has(feedId) === panelOpen) return current;
      const next = new Set(current);
      if (panelOpen) next.add(feedId);
      else next.delete(feedId);
      return next;
    });
  }, []);
  const activeFeedOnly = shouldUseActiveFeedLayout({
    narrowScreen,
    editorEmbeddedOpen,
    availableWidth,
    feedCount: messageFeeds.length,
  });
  const showAddButton = messageFeeds.length < MAX_MESSAGE_FEEDS;
  const compactFeedTabs = messageFeeds.length >= DUTY_ICON_ONLY_FEED_TAB_MIN_FEEDS;
  const activeOnlyFeed =
    activeFeedOnly && messageFeeds.length > 0
      ? (messageFeeds.find((feed) => feed.id === activeFeedId) ?? messageFeeds[0])
      : null;
  const activeFeedIndex = activeOnlyFeed
    ? messageFeeds.findIndex((feed) => feed.id === activeOnlyFeed.id)
    : -1;
  const activeOnlyColumn = activeOnlyFeed
    ? (() => {
        const column = buildFeedColumnModel(activeOnlyFeed);
        return {
          ...column,
          view: {
            ...column.view,
            scrollTrackingEnabled: true,
            workspaceFabAvoidance: 'above' as const,
            initialScrollAnchorSnapshot:
              feedScrollAnchorsRef.current.get(activeOnlyFeed.id) ?? null,
            onScrollAnchorSnapshotChange: handleScrollAnchorSnapshotChange,
          },
          actions: {
            ...column.actions,
            onCreateFeed: showAddButton ? createMessageFeed : undefined,
          },
        };
      })()
    : null;

  return (
    <Box className="flex flex-1 min-h-0 w-full overflow-hidden">
      {isInitialLoading ? (
        <DutyNeoInitialLoadingSkeleton feedCount={messageFeeds.length} narrow={activeFeedOnly} />
      ) : (
        <Box
          ref={editorEmbeddedOpen ? workspaceRef : undefined}
          data-duty-workspace-main
          className="h-full min-h-0 w-full overflow-hidden flex gap-2"
          sx={{
            position: 'relative',
          }}
        >
          <Box className="flex flex-1 min-w-0 min-h-0 flex-col gap-2">
            {activeFeedOnly && messageFeeds.length > 1 && activeOnlyFeed && (
              <Box
                sx={{
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'stretch',
                  height: 48,
                  backgroundColor: 'background.paper',
                  borderRadius: 1,
                  overflow: 'hidden',
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Box
                  role="tablist"
                  aria-label="Стрічки"
                  sx={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    position: 'relative',
                    height: '100%',
                  }}
                >
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: `repeat(${messageFeeds.length}, minmax(0, 1fr))`,
                      height: '100%',
                    }}
                  >
                    {messageFeeds.map((feed, index) => {
                      const selected = feed.id === activeOnlyFeed.id;
                      const tabLabel = `Стрічка ${index + 1}`;
                      return (
                        <ButtonBase
                          key={feed.id}
                          role="tab"
                          aria-selected={selected}
                          aria-label={tabLabel}
                          onClick={() => onSelectFeed(feed.id)}
                          sx={{
                            minWidth: 0,
                            minHeight: 0,
                            height: '100%',
                            px: compactFeedTabs ? 0.5 : 1,
                            color: selected ? 'primary.main' : 'text.primary',
                            fontWeight: 500,
                            fontSize: '0.875rem',
                            lineHeight: 1.43,
                            letterSpacing: '0.01071em',
                            textTransform: compactFeedTabs ? 'none' : 'uppercase',
                            opacity: selected ? 1 : 0.72,
                            transition: 'color 0.15s ease',
                            overflow: 'hidden',
                            '&:hover': {
                              backgroundColor: 'action.hover',
                              opacity: 1,
                            },
                          }}
                        >
                          {compactFeedTabs ? (
                            <Tooltip title={tabLabel}>
                              <Box
                                component="span"
                                aria-hidden
                                sx={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: '50%',
                                  border: '2px solid',
                                  borderColor: selected ? 'primary.main' : 'text.secondary',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: '0.8125rem',
                                  fontWeight: 700,
                                  lineHeight: 1,
                                }}
                              >
                                {index + 1}
                              </Box>
                            </Tooltip>
                          ) : (
                            <Box
                              component="span"
                              sx={{
                                display: 'block',
                                width: '100%',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {tabLabel}
                            </Box>
                          )}
                        </ButtonBase>
                      );
                    })}
                  </Box>
                  {activeFeedIndex >= 0 && (
                    <Box
                      aria-hidden
                      sx={{
                        position: 'absolute',
                        left: `calc(${activeFeedIndex} * (100% / ${messageFeeds.length}))`,
                        bottom: 0,
                        width: `calc(100% / ${messageFeeds.length})`,
                        height: 4,
                        borderRadius: 999,
                        backgroundColor: 'primary.main',
                        transition: 'left 0.2s ease, width 0.2s ease',
                      }}
                    />
                  )}
                </Box>
              </Box>
            )}
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
              {activeFeedOnly ? (
                activeOnlyColumn && activeOnlyFeed ? (
                  <Box
                    key={activeOnlyFeed.id}
                    data-duty-feed-column-active="true"
                    sx={{
                      position: 'absolute',
                      inset: 0,
                      display: 'flex',
                      minHeight: 0,
                      minWidth: 0,
                    }}
                  >
                    <FeedColumn
                      ref={(el) => {
                        columnRefsRef.current[activeOnlyFeed.id] = el;
                      }}
                      column={activeOnlyColumn}
                      onPanelOpenChange={handlePanelOpenChange}
                    />
                  </Box>
                ) : null
              ) : (
                <Box
                  className="h-full min-h-0 w-full overflow-hidden"
                  sx={{
                    display: messageFeeds.length <= 1 ? 'flex' : 'grid',
                    alignItems: 'start',
                    justifyContent: messageFeeds.length <= 1 ? 'center' : 'stretch',
                    gap: messageFeeds.length <= 1 ? 1 : 2,
                    gridTemplateColumns:
                      messageFeeds.length <= 1
                        ? undefined
                        : `repeat(${messageFeeds.length}, minmax(0, 1fr))`,
                  }}
                >
                  {messageFeeds.map((feed, index) => {
                    const column = buildFeedColumnModel(feed);
                    const columnView: FeedColumnModel['view'] = {
                      ...column.view,
                      scrollTrackingEnabled: true,
                      // A lone desktop feed owns its scroll action; only multi-feed layouts need
                      // to reserve horizontal space for the workspace-level create action.
                      workspaceFabAvoidance:
                        !editorOpen && messageFeeds.length > 1 && index === messageFeeds.length - 1
                          ? 'left'
                          : 'none',
                      initialScrollAnchorSnapshot:
                        feedScrollAnchorsRef.current.get(feed.id) ?? null,
                      onScrollAnchorSnapshotChange: handleScrollAnchorSnapshotChange,
                    };
                    return (
                      <FeedColumn
                        key={feed.id}
                        ref={(el) => {
                          columnRefsRef.current[feed.id] = el;
                        }}
                        column={{
                          ...column,
                          view: columnView,
                          actions: {
                            ...column.actions,
                            onCreateFeed:
                              index === messageFeeds.length - 1 && showAddButton
                                ? createMessageFeed
                                : undefined,
                          },
                        }}
                        onPanelOpenChange={handlePanelOpenChange}
                      />
                    );
                  })}
                </Box>
              )}
            </Box>
          </Box>
        </Box>
      )}
      {!editorOpen && feedsWithOpenPanels.size === 0 ? (
        <CreateMessageFab
          ref={createMessageFabRef}
          onClick={openCreateMessageComposer}
          rightInset={DUTY_WORKSPACE_CREATE_MESSAGE_RIGHT_INSET}
        />
      ) : null}

      <Backdrop
        open={showLoadingBackdrop}
        sx={{
          position: 'absolute',
          inset: 0,
          /**
           * Keep the refresh overlay behind the feed filter/notification popovers so users can still
           * adjust or cancel filters while newer messages are loading.
           */
          zIndex: 1,
          color: 'primary.light',
          backgroundColor: 'rgba(7, 10, 14, 0.42)',
        }}
      >
        <CircularProgress color="inherit" />
      </Backdrop>
    </Box>
  );
}
