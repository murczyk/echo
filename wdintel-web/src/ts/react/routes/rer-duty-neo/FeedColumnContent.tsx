import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { Box, CircularProgress, Fab, Paper, Typography } from '@mui/material';
import { forwardRef, useImperativeHandle, useMemo, useState } from 'react';
import { ELLIPSIS, isNullOrUndefined, isPresent } from '../../utils/misc';
import type { FeedColumnModel } from './FeedColumn';
import { PowerChip } from '../../components/PowerChip';
import { DutyMessageCard } from '../shared/message-card/MessageCard';
import { buildMessageCardDisplayLabels } from '../shared/message-card/message-card-labels';
import {
  buildCopyTextWithNetworkAndNote,
  buildCopyTextWithNetworkName,
  resolveMessageCardEtalonDisplayModel,
} from '../shared/message-card/message-card.utils';
import { dutyTopScrollButtonSx } from './top-action-styles';
import { useWindowedFeedScroll } from './useWindowedFeedScroll';

/** Start loading older messages when the user scrolls close to the top of the DOM list. */
const LOAD_OLDER_BUFFER_PX = 160;
/** Treat the feed as "near bottom" inside this pixel range so polling can fetch newer messages. */
const LOAD_NEWER_NEAR_BOTTOM_BUFFER_PX = 320;
/** Consider "at bottom" when within this many pixels of the scroll end (watch mode / read-state). */
const DUTY_FEED_AT_BOTTOM_THRESHOLD_PX = 25;

export type FeedColumnContentHandle = {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
};

type FeedColumnContentProps = {
  column: FeedColumnModel;
};

export const FeedColumnContent = forwardRef<FeedColumnContentHandle, FeedColumnContentProps>(
  function FeedColumnContent({ column }, ref) {
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
    } = messageCard;
    const {
      onLoadOlder,
      onLoadNewer,
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
    const scrollItems = useMemo(() => feed.items.map(([id]) => ({ id })), [feed.items]);
    const scroll = useWindowedFeedScroll({
      items: scrollItems,
      loadingOlder: feed.loadingOlder,
      loadingNewer,
      hasReachedStart: feed.hasReachedStart,
      onLoadOlder,
      onLoadNewer,
      onScrollToTop,
      onReachedBottom,
      onLeftBottom,
      onNearBottomChange,
      onAtBottomChange: (atBottom) => {
        setIsAtBottom(atBottom);
        onAtBottomChange?.(atBottom);
      },
      onVisibleMessageIds,
      topLoadBufferPx: LOAD_OLDER_BUFFER_PX,
      bottomLoadBufferPx: LOAD_NEWER_NEAR_BOTTOM_BUFFER_PX,
      atBottomThresholdPx: DUTY_FEED_AT_BOTTOM_THRESHOLD_PX,
      resetKey: feed.referenceTimeMs ?? feed.id,
    });

    useImperativeHandle(ref, () => ({ scrollToBottom: scroll.scrollToBottom }), [scroll.scrollToBottom]);

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
          position: 'relative',
        }}
      >
        <Box
          ref={scroll.scrollerRef}
          data-duty-feed-scroller="true"
          component="div"
          className="rer-duty-feed-scroll"
          onScroll={scroll.handleScroll}
          sx={{
            flex: 1,
            minHeight: narrowScreen ? 0 : 400,
            overflowY: 'auto',
            overflowX: 'hidden',
            pl: '12px',
            scrollbarGutter: 'stable',
            boxSizing: 'border-box',
          }}
        >
          {feed.loadingOlder ? (
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
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 1.5 }}>
              Немає старіших повідомлень
            </Typography>
          ) : null}
          {feed.items.length === 0 ? (
            <Typography color="text.secondary" className="p-4">
              Немає повідомлень
            </Typography>
          ) : (
            <Box
              data-duty-feed-list="true"
              className="m-0 list-none rer-duty pt-2"
              sx={{ pr: '12px', boxSizing: 'border-box' }}
            >
              {feed.items.map(([id, msg]) => {
                const labels = buildMessageCardDisplayLabels(msg, { groupInfos, profiles });
                const etalonDisplayModel = resolveMessageCardEtalonDisplayModel(msg, {
                  featureStrictNetworks,
                  networkDisplayMap,
                  networkMap,
                  networks: networkMap ? Object.values(networkMap) : undefined,
                });
                return (
                  <Box key={id} ref={scroll.setItemRef(id)} data-duty-message-id={id}>
                    <DutyMessageCard
                      id={id}
                      msg={msg}
                      feedCount={feedCount}
                      tagsLayout={tagsLayout}
                      referenceTimeMs={feed.referenceTimeMs}
                      authUserName={authUserName}
                      groupName={labels.groupName}
                      senderName={labels.senderName}
                      copiedFeedbackId={copiedFeedbackId}
                      networkDisplayMap={networkDisplayMap}
                      messageComments={[]}
                      networkMap={networkMap}
                      unitsMap={unitsMap}
                      callsignInfoMap={callsignInfoMap}
                      networks={networkMap ? Object.values(networkMap) : undefined}
                      featureStrictNetworks={featureStrictNetworks}
                      tagsMap={tagsMap}
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
                              onMessageCopy(
                                etalonDisplayModel.copyLocationValue ?? '',
                                `location-${id}`,
                              )
                      }
                      onAddFrequencyToFilter={(freq) => onMessageAddFrequencyToFilter(feed.id, freq)}
                      onComment={() => onMessageComment(id, msg.extendedForm ?? null)}
                      onExcludeMessageEntity={(entity, value) => onMessageExcludeEntity(entity, value)}
                      onToggleTag={(tagId) => onMessageToggleTag(id, tagId)}
                      rightHeaderInsetPx={0}
                      filterState={feed.filter}
                    />
                  </Box>
                );
              })}
            </Box>
          )}
        </Box>
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
                aria-label={isWatchMode ? 'Режим перегляду нових' : 'Завантажити нові та перейти вниз'}
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
  },
);
