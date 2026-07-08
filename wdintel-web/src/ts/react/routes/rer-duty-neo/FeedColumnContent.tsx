import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { Box, CircularProgress, Fab, Paper, Typography } from '@mui/material';
import { forwardRef, memo, useImperativeHandle, useMemo, useState } from 'react';
import type {
  CallsignInfoRes,
  InboxMessage,
  Network,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
} from '../../../../Bindings';
import { ELLIPSIS, isNullOrUndefined, isPresent } from '../../utils/misc';
import type { FeedColumnModel } from './FeedColumn';
import { PowerChip } from '../../components/PowerChip';
import { DutyMessageCard } from '../shared/message-card/MessageCard';
import type { MessageCardBotTagAction } from '../shared/message-card/message-card.types';
import { buildMessageCardDisplayLabels } from '../shared/message-card/message-card-labels';
import {
  buildCopyTextWithNetworkAndNote,
  buildCopyTextWithNetworkName,
  resolveMessageCardEtalonDisplayModel,
} from '../shared/message-card/message-card.utils';
import type { MessageEntityFilterKind, TagsLayoutVariant } from './utils';
import { dutyTopScrollButtonSx } from './top-action-styles';
import { useWindowedFeedScroll } from './useWindowedFeedScroll';

/** Start loading older messages when the user scrolls close to the top of the DOM list. */
const LOAD_OLDER_BUFFER_PX = 160;
/** Start loading newer messages before the user gets close to the bottom edge. */
const LOAD_NEWER_NEAR_BOTTOM_BUFFER_PX = 800;
/** Consider "at bottom" when within this many pixels of the scroll end (watch mode / read-state). */
const DUTY_FEED_AT_BOTTOM_THRESHOLD_PX = 25;

// Hoisted stable empty array: passing `[]` inline as a prop would allocate a fresh reference
// every render, defeating React.memo / useMemo bailouts downstream in MessageCard.
const EMPTY_MESSAGE_COMMENTS: never[] = [];

export type FeedColumnContentHandle = {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
};

type FeedColumnContentProps = {
  column: FeedColumnModel;
};

type DutyMessageCardItemProps = {
  id: number;
  msg: InboxMessage;
  feedId: string;
  feedCount?: number;
  tagsLayout: TagsLayoutVariant;
  botTagAction: MessageCardBotTagAction | null;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void | Promise<void>;
  referenceTimeMs: number | null;
  authUserName: string | null;
  groupInfos: Record<string, SignalGroupEntry>;
  profiles: Record<string, SignalProfileEntry | null>;
  copiedFeedbackId: string | null;
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
  unitsMap: Record<number, Unit>;
  callsignInfoMap: Record<string, CallsignInfoRes>;
  networks?: Network[];
  featureStrictNetworks: boolean;
  tagsMap: Record<number, Tag>;
  filterState: RerDutyFeedFilterState;
  onMessageBookmark: (msgId: number, currentlyBookmarked: boolean) => void;
  onMessageImportant: (msgId: number, currentlyImportant: boolean) => void;
  onMessageCopy: (text: string, feedbackId: string) => void;
  onMessageAddFrequencyToFilter: (feedId: string, freq: string) => void;
  onMessageComment: (msgId: number, currentComment: string | null) => void;
  onMessageExcludeEntity: (entity: MessageEntityFilterKind, value: string) => void;
  onMessageToggleTag: (msgId: number, tagId: number) => void;
};

const DutyMessageCardItem = memo(function DutyMessageCardItem({
  id,
  msg,
  feedId,
  feedCount,
  tagsLayout,
  botTagAction,
  onCancelBotTagAction,
  onMarkBotTagWrong,
  referenceTimeMs,
  authUserName,
  groupInfos,
  profiles,
  copiedFeedbackId,
  networkDisplayMap,
  networkMap,
  unitsMap,
  callsignInfoMap,
  networks,
  featureStrictNetworks,
  tagsMap,
  filterState,
  onMessageBookmark,
  onMessageImportant,
  onMessageCopy,
  onMessageAddFrequencyToFilter,
  onMessageComment,
  onMessageExcludeEntity,
  onMessageToggleTag,
}: DutyMessageCardItemProps) {
  const labels = buildMessageCardDisplayLabels(msg, { groupInfos, profiles });
  const etalonDisplayModel = resolveMessageCardEtalonDisplayModel(msg, {
    featureStrictNetworks,
    networkDisplayMap,
    networkMap,
    networks,
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
      referenceTimeMs={referenceTimeMs}
      authUserName={authUserName}
      groupName={labels.groupName}
      senderName={labels.senderName}
      copiedFeedbackId={copiedFeedbackId}
      networkDisplayMap={networkDisplayMap}
      messageComments={EMPTY_MESSAGE_COMMENTS}
      networkMap={networkMap}
      unitsMap={unitsMap}
      callsignInfoMap={callsignInfoMap}
      networks={networks}
      featureStrictNetworks={featureStrictNetworks}
      tagsMap={tagsMap}
      onBookmark={() => onMessageBookmark(id, msg.bookmarked)}
      onImportant={() => onMessageImportant(id, msg.important)}
      onCopyText={() => onMessageCopy(msg.text || '', `text-${id}`)}
      onCopyFreq={() => onMessageCopy(msg.freq ?? '', `freq-${id}`)}
      onCopyTextWithNetwork={
        etalonDisplayModel.primaryKind === 'network' && etalonDisplayModel.copyEtalonValue != null
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
          : () => onMessageCopy(etalonDisplayModel.copyLocationValue ?? '', `location-${id}`)
      }
      onAddFrequencyToFilter={(freq) => onMessageAddFrequencyToFilter(feedId, freq)}
      onComment={() => onMessageComment(id, msg.extendedForm ?? null)}
      onExcludeMessageEntity={(entity, value) => onMessageExcludeEntity(entity, value)}
      onToggleTag={(tagId) => onMessageToggleTag(id, tagId)}
      rightHeaderInsetPx={0}
      filterState={filterState}
    />
  );
});

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
      botTagAction,
      onCancelBotTagAction,
      onMarkBotTagWrong,
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
    const networks = useMemo(
      () => (networkMap ? Object.values(networkMap) : undefined),
      [networkMap],
    );
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

    useImperativeHandle(ref, () => ({ scrollToBottom: scroll.scrollToBottom }), [
      scroll.scrollToBottom,
    ]);

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
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ textAlign: 'center', py: 1.5 }}
            >
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
              {feed.items.map(([id, msg]) => (
                <Box key={id} ref={scroll.setItemRef(id)} data-duty-message-id={id}>
                  <DutyMessageCardItem
                    id={id}
                    msg={msg}
                    feedId={feed.id}
                    feedCount={feedCount}
                    tagsLayout={tagsLayout}
                    botTagAction={botTagAction}
                    onCancelBotTagAction={onCancelBotTagAction}
                    onMarkBotTagWrong={onMarkBotTagWrong}
                    referenceTimeMs={feed.referenceTimeMs}
                    authUserName={authUserName}
                    groupInfos={groupInfos}
                    profiles={profiles}
                    copiedFeedbackId={copiedFeedbackId}
                    networkDisplayMap={networkDisplayMap}
                    networkMap={networkMap}
                    unitsMap={unitsMap}
                    callsignInfoMap={callsignInfoMap}
                    networks={networks}
                    featureStrictNetworks={featureStrictNetworks}
                    tagsMap={tagsMap}
                    filterState={feed.filter}
                    onMessageBookmark={onMessageBookmark}
                    onMessageImportant={onMessageImportant}
                    onMessageCopy={onMessageCopy}
                    onMessageAddFrequencyToFilter={onMessageAddFrequencyToFilter}
                    onMessageComment={onMessageComment}
                    onMessageExcludeEntity={onMessageExcludeEntity}
                    onMessageToggleTag={onMessageToggleTag}
                  />
                </Box>
              ))}
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
  },
);
