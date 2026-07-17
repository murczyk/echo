import AddIcon from '@mui/icons-material/Add';
import { Backdrop, Box, ButtonBase, CircularProgress, Fab, Skeleton, Tooltip } from '@mui/material';
import { isPresent } from '../../utils/misc';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { FeedColumn, type FeedColumnHandle, type FeedColumnModel } from './FeedColumn';
import { DUTY_ICON_ONLY_FEED_TAB_MIN_FEEDS } from './FeedColumnHeader';
import { dutyTopAddFabSx } from './top-action-styles';
import type { MessageFeedState } from './utils';
import { MAX_MESSAGE_FEEDS } from './utils';
import { CreateMessageFab } from '../shared/manage-message/CreateMessageFab';

function dutyFeedColumnMaxWidth(feedCount: number, narrow: boolean): string {
  if (narrow) return '100%';
  if (feedCount <= 1) return '960px';
  return '100%';
}

function DutyNeoInitialLoadingSkeletonFeedHeader() {
  return (
    <Box
      data-duty-skeleton-feed-header="true"
      sx={{
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'space-between',
        gap: 1,
        flexShrink: 0,
        minHeight: 48,
        px: 1,
        py: 1,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        backgroundColor: 'background.paper',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'stretch', minWidth: 0, gap: 0.5 }}>
        <Skeleton variant="rounded" width={168} height={32} />
        <Skeleton variant="rounded" width={32} height={32} />
        <Skeleton variant="rounded" width={144} height={32} />
      </Box>
      <Skeleton variant="rounded" width={32} height={32} />
    </Box>
  );
}

function DutyNeoInitialLoadingSkeletonFeedColumn({ messageCount }: { messageCount: number }) {
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
      <DutyNeoInitialLoadingSkeletonFeedHeader />
      {Array.from({ length: messageCount }).map((_, messageIndex) => (
        <Box
          key={messageIndex}
          sx={{
            display: 'flex',
            minWidth: 0,
            flexDirection: 'column',
            gap: 1.25,
            pb: messageIndex + 1 === messageCount ? 0 : 2,
            mb: messageIndex + 1 === messageCount ? 0 : 2,
            borderBottom:
              messageIndex + 1 === messageCount ? 'none' : '1px solid rgba(148, 163, 184, 0.14)',
          }}
        >
          <Skeleton
            variant="rounded"
            height={28}
            width={`${72 - Math.min(messageIndex * 6, 18)}%`}
          />
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            <Skeleton variant="rounded" height={24} width={72 - messageIndex * 2} />
            <Skeleton variant="rounded" height={24} width={92 - messageIndex * 3} />
            <Skeleton variant="rounded" height={24} width={64 - messageIndex * 2} />
          </Box>
          <Skeleton variant="rounded" height={92} />
          <Skeleton variant="rounded" height={18} width="92%" />
          <Skeleton variant="rounded" height={18} width="84%" />
          <Skeleton variant="rounded" height={18} width="76%" />
        </Box>
      ))}
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
  openCreateMessageComposer: () => void;
  isInitialLoading: boolean;
  messageFeeds: MessageFeedState[];
  narrowScreen: boolean;
  onSelectFeed: Dispatch<SetStateAction<string | null>>;
  showLoadingBackdrop: boolean;
};

export function RerDutyNeoWorkspace({
  activeFeedId,
  buildFeedColumnModel,
  columnRefsRef,
  createMessageFeed,
  openCreateMessageComposer,
  isInitialLoading,
  messageFeeds,
  narrowScreen,
  onSelectFeed,
  showLoadingBackdrop,
}: RerDutyNeoWorkspaceProps) {
  const activeFeedIndex = isPresent(activeFeedId)
    ? messageFeeds.findIndex((feed) => feed.id === activeFeedId)
    : -1;
  const showAddButton = messageFeeds.length < MAX_MESSAGE_FEEDS;
  const compactFeedTabs = messageFeeds.length >= DUTY_ICON_ONLY_FEED_TAB_MIN_FEEDS;

  return (
    <Box className="flex flex-1 min-h-0 w-full overflow-hidden">
      {isInitialLoading ? (
        <DutyNeoInitialLoadingSkeleton feedCount={messageFeeds.length} narrow={narrowScreen} />
      ) : (
        <Box
          data-duty-workspace-main
          className="h-full min-h-0 w-full overflow-hidden flex gap-2"
          style={{ paddingTop: narrowScreen ? 0 : 48 }}
          sx={{
            position: 'relative',
          }}
        >
          <Box className="flex flex-1 min-w-0 min-h-0 flex-col gap-2">
            {narrowScreen && messageFeeds.length > 1 && isPresent(activeFeedId) && (
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
                      const selected = feed.id === activeFeedId;
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
              {narrowScreen ? (
                messageFeeds.map((feed) => {
                  const isActive = feed.id === activeFeedId;
                  const column = buildFeedColumnModel(feed);
                  return (
                    <Box
                      key={feed.id}
                      data-duty-feed-column-active={isActive ? 'true' : undefined}
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        display: isActive ? 'flex' : 'none',
                        minHeight: 0,
                        minWidth: 0,
                      }}
                    >
                      <FeedColumn
                        ref={(el) => {
                          columnRefsRef.current[feed.id] = el;
                        }}
                        column={{
                          ...column,
                          actions: {
                            ...column.actions,
                            onCreateMessage: isActive ? openCreateMessageComposer : undefined,
                            onCreateFeed: isActive && showAddButton ? createMessageFeed : undefined,
                          },
                        }}
                      />
                    </Box>
                  );
                })
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
                  {messageFeeds.map((feed) => (
                    <FeedColumn
                      key={feed.id}
                      ref={(el) => {
                        columnRefsRef.current[feed.id] = el;
                      }}
                      column={buildFeedColumnModel(feed)}
                    />
                  ))}
                </Box>
              )}
            </Box>
          </Box>
          {!narrowScreen && showAddButton && (
            <Box
              sx={{
                position: 'absolute',
                right: 12,
                top: { xs: 'max(12px, env(safe-area-inset-top, 0px))', sm: 12 },
                display: 'flex',
                pointerEvents: 'none',
                zIndex: 2,
              }}
            >
              <Fab
                color="primary"
                aria-label="Додати стрічку"
                onClick={createMessageFeed}
                sx={{ ...dutyTopAddFabSx, pointerEvents: 'auto' }}
              >
                <AddIcon />
              </Fab>
            </Box>
          )}
        </Box>
      )}
      {!narrowScreen ? <CreateMessageFab onClick={openCreateMessageComposer} /> : null}

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
