import { Box, CircularProgress, Fab, Paper, Typography } from '@mui/material';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentProps, Ref, RefObject } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { ELLIPSIS, isNullOrUndefined, isPresent } from '../../utils/misc';
import type { FeedColumnModel } from './FeedColumn';
import { DutyMessageCard } from '../shared/message-card/MessageCard';
import { PowerChip } from '../../components/PowerChip';
import {
  resolveMessageCardEtalonDisplayModel,
  buildCopyTextWithNetworkAndNote,
  buildCopyTextWithNetworkName,
} from '../shared/message-card/message-card.utils';
import { buildMessageCardDisplayLabels } from '../shared/message-card/message-card-labels';
import { dutyTopScrollButtonSx } from './top-action-styles';

/** When the visible range enters this many items from the bottom (oldest at top, newest at bottom), load 20 older messages to keep scroll position and unread count. */
const LOAD_OLDER_BUFFER_ITEMS = 10;
/** Virtuoso: consider "at bottom" when within this many pixels of the scroll end (watch mode / reach-bottom). */
const DUTY_FEED_AT_BOTTOM_THRESHOLD_PX = 25;
/** After loading older, don't trigger again until the user scrolls back up so the visible range is at least this far from the bottom. */
const LOAD_OLDER_RESET_MARGIN = 20;

const FeedScroller = forwardRef<HTMLDivElement, ComponentProps<'div'>>(function FeedScroller(
  { style, className, ...props },
  ref,
) {
  return (
    <Box
      ref={ref}
      data-virtuoso-scroller
      component="div"
      style={style}
      sx={{
        pl: '12px',
        scrollbarGutter: 'stable',
        boxSizing: 'border-box',
        overflowX: 'hidden',
      }}
      className={[className, 'rer-duty-feed-scroll'].filter(Boolean).join(' ')}
      {...props}
    />
  );
});

const FeedList = forwardRef<HTMLDivElement, ComponentProps<'div'>>(function FeedList(
  { style, className, ...props },
  ref,
) {
  return (
    <Box
      ref={ref}
      component="div"
      style={style}
      sx={{
        pr: '12px',
        boxSizing: 'border-box',
      }}
      className={className}
      {...props}
    />
  );
});

type FeedColumnContentProps = {
  column: FeedColumnModel;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
};

export function FeedColumnContent({ column, virtuosoRef }: FeedColumnContentProps) {
  const { feed, view, messageCard, actions } = column;
  const {
    narrowScreen = false,
    feedCount,
    loadingNewer = false,
    arrowResultMessage = null,
    unreadCount = 0,
    isWatchMode = false,
  } = view;
  const {
    authUserName,
    copiedFeedbackId,
    networkDisplayMap,
    networkMap,
    unitsMap,
    callsignInfoMap,
    groupInfos,
    profiles,
    featureStrictNetworks,
    tagsLayout,
    tagsMap,
    tagsOrder,
    botTagAction,
    onCancelBotTagAction,
    onMarkBotTagWrong,
  } = messageCard;
  const {
    onLoadOlder,
    onMessageBookmark,
    onMessageImportant,
    onMessageAddFrequencyToFilter,
    onMessageCopy,
    onMessageComment,
    onMessageExcludeEntity,
    onMessageToggleTag,
    onScrollToTop,
    onReachedBottom,
    onLeftBottom,
    onNearBottomChange,
    onAtBottomChange,
    onArrowClick,
    onVisibleMessageIds,
  } = actions;
  const [isAtBottom, setIsAtBottom] = useState(true);
  const loadOlderTriggeredRef = useRef(false);
  const hasSeenNotAtBottomRef = useRef(false);
  const atBottomRef = useRef(true);
  const nearBottomRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!feed.loadingOlder) loadOlderTriggeredRef.current = false;
  }, [feed.loadingOlder]);

  const tryLoadOlder = useCallback(() => {
    if (loadOlderTriggeredRef.current || feed.loadingOlder || feed.hasReachedStart) return;
    loadOlderTriggeredRef.current = true;
    onLoadOlder();
  }, [feed.loadingOlder, feed.hasReachedStart, onLoadOlder]);

  const firstItemIndex = feed.firstItemIndex ?? 0;
  const handleRangeChanged = useCallback(
    (range: { startIndex: number; endIndex: number }) => {
      const len = feed.items.length;
      const startDataIndex = range.startIndex - firstItemIndex;
      const endDataIndex = range.endIndex - firstItemIndex;
      const nearTop =
        len <= LOAD_OLDER_BUFFER_ITEMS
          ? len > 0 && startDataIndex <= 0
          : startDataIndex < LOAD_OLDER_BUFFER_ITEMS;
      if (nearTop) {
        tryLoadOlder();
      } else if (startDataIndex > LOAD_OLDER_RESET_MARGIN) {
        loadOlderTriggeredRef.current = false;
      }
      const nearBottom =
        len <= LOAD_OLDER_BUFFER_ITEMS
          ? len > 0 && endDataIndex >= len - 1
          : endDataIndex >= len - LOAD_OLDER_BUFFER_ITEMS;
      if (nearBottomRef.current !== nearBottom) {
        nearBottomRef.current = nearBottom;
        onNearBottomChange?.(nearBottom);
      }
      if (isPresent(onVisibleMessageIds) && len > 0) {
        const ids: number[] = [];
        for (let dataIndex = 0; dataIndex <= endDataIndex && dataIndex < len; dataIndex += 1) {
          ids.push(feed.items[dataIndex][0]);
        }
        if (ids.length > 0) onVisibleMessageIds(ids, { atBottom: false });
      }
    },
    [
      feed.items,
      feed.items.length,
      firstItemIndex,
      onNearBottomChange,
      onVisibleMessageIds,
      tryLoadOlder,
    ],
  );

  if (feed.loading && feed.items.length === 0) {
    return (
      <Box className="flex-1 flex justify-center items-center min-h-0">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Paper
      variant="outlined"
      className="flex-1 overflow-hidden min-h-0 p-0 flex flex-col h-full"
      sx={{
        mt: '-1px',
        borderTopLeftRadius: 0,
        borderTopRightRadius: 0,
      }}
    >
      <Virtuoso
        ref={virtuosoRef as unknown as Ref<VirtuosoHandle>}
        style={{ flex: 1, minHeight: narrowScreen ? 0 : 400 }}
        data={feed.items}
        firstItemIndex={feed.firstItemIndex ?? 0}
        computeItemKey={(_index, [id]) => String(id)}
        {...(feed.items.length > 0
          ? {
              initialTopMostItemIndex: {
                index: feed.items.length - 1,
                align: 'end' as const,
              },
            }
          : {})}
        startReached={tryLoadOlder}
        rangeChanged={handleRangeChanged}
        atTopStateChange={(atTop) => {
          if (atTop) {
            onScrollToTop?.();
            tryLoadOlder();
          }
        }}
        atBottomThreshold={DUTY_FEED_AT_BOTTOM_THRESHOLD_PX}
        atBottomStateChange={(atBottom) => {
          const wasAtBottom = atBottomRef.current;
          atBottomRef.current = atBottom;
          onAtBottomChange?.(atBottom);
          if (!atBottom) hasSeenNotAtBottomRef.current = true;
          setIsAtBottom(atBottom);
          if (atBottom && hasSeenNotAtBottomRef.current) onReachedBottom?.();
          if (!atBottom && wasAtBottom) onLeftBottom?.();
          if (atBottom && isPresent(onVisibleMessageIds) && feed.items.length > 0) {
            onVisibleMessageIds(
              feed.items.map(([id]) => id),
              { atBottom: true },
            );
          }
        }}
        components={{
          Scroller: FeedScroller,
          Header: () =>
            feed.loadingOlder ? (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 1,
                  py: 1.5,
                  color: 'text.secondary',
                }}
              >
                <CircularProgress size={18} />
                <Typography variant="body2">{`Завантаження старіших${ELLIPSIS}`}</Typography>
              </Box>
            ) : feed.hasReachedStart ? (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ textAlign: 'center', py: 1.5 }}
              >
                Немає старіших повідомлень
              </Typography>
            ) : null,
          EmptyPlaceholder: () => (
            <Typography color="text.secondary" className="p-4">
              Немає повідомлень
            </Typography>
          ),
          List: FeedList,
        }}
        className="m-0 list-none rer-duty pt-2"
        itemContent={(_index, [id, msg]) => {
          const labels = buildMessageCardDisplayLabels(msg, { groupInfos, profiles });
          const etalonDisplayModel = resolveMessageCardEtalonDisplayModel(msg, {
            featureStrictNetworks,
            networkDisplayMap,
            networkMap,
            networks: networkMap ? Object.values(networkMap) : undefined,
          });
          return (
            <DutyMessageCard
              id={id}
              msg={msg}
              feedCount={feedCount}
              tagsLayout={tagsLayout}
              botTagAction={botTagAction?.messageId === id ? botTagAction : null}
              onCancelBotTagAction={onCancelBotTagAction}
              onMarkBotTagWrong={onMarkBotTagWrong}
              referenceTimeMs={feed.referenceTimeMs}
              authUserName={authUserName}
              groupName={labels.groupName}
              senderName={labels.senderName}
              copiedFeedbackId={copiedFeedbackId}
              networkDisplayMap={networkDisplayMap}
              /* Duty shows only `msg.extendedForm`; peer/post comments belong to analysis. */
              messageComments={[]}
              networkMap={networkMap}
              unitsMap={unitsMap}
              callsignInfoMap={callsignInfoMap}
              networks={networkMap ? Object.values(networkMap) : undefined}
              featureStrictNetworks={featureStrictNetworks}
              tagsMap={tagsMap}
              tagsOrder={tagsOrder}
              onBookmark={() => onMessageBookmark(id, msg.bookmarked)}
              onImportant={() => onMessageImportant(id, msg.important)}
              onCopyText={() => onMessageCopy(msg.text || '', `text-${id}`)}
              onCopyFreq={() => onMessageCopy(msg.freq ?? '', `freq-${id}`)}
              onCopyTextWithNetwork={
                etalonDisplayModel.primaryKind === 'network' &&
                etalonDisplayModel.copyEtalonValue != null
                  ? () =>
                      onMessageCopy(
                        buildCopyTextWithNetworkName(
                          msg.text || '',
                          etalonDisplayModel.copyEtalonValue,
                          msg.noHeadersBody,
                        ),
                        `text-network-${id}`,
                      )
                  : undefined
              }
              onCopyTextWithNetworkAndNote={
                etalonDisplayModel.primaryKind === 'network' &&
                etalonDisplayModel.copyEtalonValue != null &&
                isPresent(msg.extendedForm) &&
                msg.extendedForm.trim() !== ''
                  ? () =>
                      onMessageCopy(
                        buildCopyTextWithNetworkAndNote(
                          msg.text || '',
                          etalonDisplayModel.copyEtalonValue,
                          msg.extendedForm,
                          msg.noHeadersBody,
                        ),
                        `text-network-note-${id}`,
                      )
                  : undefined
              }
              onCopyEtalon={
                etalonDisplayModel.copyEtalonValue == null
                  ? undefined
                  : () => onMessageCopy(etalonDisplayModel.copyEtalonValue ?? '', `etalon-${id}`)
              }
              onCopyLocation={
                etalonDisplayModel.copyLocationValue == null
                  ? undefined
                  : () =>
                      onMessageCopy(etalonDisplayModel.copyLocationValue ?? '', `location-${id}`)
              }
              onAddFrequencyToFilter={(freq) => onMessageAddFrequencyToFilter(feed.id, freq)}
              onComment={() => onMessageComment(id, msg.extendedForm ?? null)}
              onExcludeMessageEntity={(entity, value) => onMessageExcludeEntity(entity, value)}
              onToggleTag={(tagId) => onMessageToggleTag(id, tagId)}
              rightHeaderInsetPx={0}
              filterState={feed.filter}
            />
          );
        }}
      />
      {isPresent(onArrowClick) && (!isAtBottom || loadingNewer || unreadCount > 0) && (
        <Box
          sx={{
            position: 'absolute',
            bottom: { xs: 'max(12px, env(safe-area-inset-bottom, 0px))', sm: 12 },
            right: { xs: 12, sm: 20 },
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            zIndex: 1,
          }}
        >
          {!loadingNewer && isPresent(arrowResultMessage) && (
            <PowerChip
              size="small"
              label={arrowResultMessage}
              interactive={false}
              unselectedOpacity={1}
              color="default"
              sx={{ fontWeight: 500 }}
            />
          )}
          <Box sx={{ position: 'relative', display: 'inline-flex' }}>
            <Fab
              color={unreadCount > 0 ? 'primary' : 'default'}
              size="small"
              sx={{
                ...dutyTopScrollButtonSx,
                position: 'relative',
                zIndex: 0,
                borderColor: unreadCount > 0 ? 'primary.main' : 'grey.400',
                color: unreadCount > 0 ? 'primary.main' : 'grey.400',
                '&:hover': {
                  backgroundColor: 'background.paper',
                  borderColor: 'primary.main',
                  color: 'primary.main',
                  boxShadow: 'none',
                },
              }}
              aria-label={
                isWatchMode ? 'Режим перегляду нових' : 'Завантажити нові та перейти вниз'
              }
              onClick={onArrowClick}
              disabled={loadingNewer}
            >
              {loadingNewer ? (
                <CircularProgress size={20} sx={{ color: 'primary.main' }} />
              ) : (
                <ArrowDownwardIcon sx={{ fontSize: 20 }} />
              )}
            </Fab>
            {!loadingNewer &&
              unreadCount > 0 &&
              !isWatchMode &&
              isNullOrUndefined(arrowResultMessage) && (
                <PowerChip
                  size="small"
                  label={unreadCount}
                  selected
                  interactive={false}
                  unselectedOpacity={1}
                  sx={{
                    position: 'absolute',
                    top: -6,
                    right: -6,
                    fontWeight: 600,
                    zIndex: 2,
                    pointerEvents: 'none',
                  }}
                />
              )}
          </Box>
        </Box>
      )}
    </Paper>
  );
}
