import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { Box, CircularProgress, Fab, Paper, Typography } from '@mui/material';
import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CallsignInfoRes,
  InboxMessage,
  MessageComment,
  Network,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
} from '../../../../Bindings';
import { ELLIPSIS, isNullOrUndefined, isPresent } from '../../utils/misc';
import type { FeedColumnModel } from './types';
import { resolveDutyScrollFabPosition } from './duty-scroll-fab-position';
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
/** Fetch the next tail window early enough to render it before the reader reaches the bottom. */
const LOAD_NEWER_BUFFER_PX = 640;
/** Consider "at bottom" when within this many pixels of the scroll end (watch mode / read-state). */
const DUTY_FEED_AT_BOTTOM_THRESHOLD_PX = 25;
// Hoisted stable empty array: passing `[]` inline as a prop would allocate a fresh reference
// every render, defeating React.memo / useMemo bailouts downstream in MessageCard.
const EMPTY_MESSAGE_COMMENTS: MessageComment[] = [];

function filterOwnMessageComments(
  messageComments: MessageComment[] | null | undefined,
  authUserName: string | null,
): MessageComment[] {
  if (!messageComments || messageComments.length === 0) return EMPTY_MESSAGE_COMMENTS;
  const activeLogin = authUserName?.trim();
  if (!activeLogin) return messageComments;
  const filtered = messageComments.filter((comment) => comment.login.trim() !== activeLogin);
  return filtered.length === 0 ? EMPTY_MESSAGE_COMMENTS : filtered;
}

export type FeedColumnContentHandle = {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
};

function useStableCallback<T extends (...args: any[]) => any>(callback: T | undefined): T {
  const ref = useRef<T | undefined>(callback);
  useLayoutEffect(() => {
    ref.current = callback;
  });
  return useCallback((...args: any[]) => {
    return ref.current?.(...args);
  }, []) as T;
}

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
  tagContributionsOrganismId?: number;
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
  tagsOrder?: number[];
  filterState: RerDutyFeedFilterState;
  onMessageBookmark: (msgId: number, currentlyBookmarked: boolean) => void;
  onMessageImportant: (msgId: number, currentlyImportant: boolean) => void;
  onMessageCopy: (text: string, feedbackId: string) => void;
  onMessageAddFrequencyToFilter: (feedId: string, freq: string) => void;
  onMessageComment: (msgId: number, currentComment: string | null) => void;
  onMessageExcludeEntity: (entity: MessageEntityFilterKind, value: string) => void;
  onMessageToggleTag: (msgId: number, tagId: number) => void;
  onMessageEdit: (messageId: number, message: InboxMessage) => void;
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
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
  tagContributionsOrganismId,
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
  tagsOrder,
  filterState,
  onMessageBookmark,
  onMessageImportant,
  onMessageCopy,
  onMessageAddFrequencyToFilter,
  onMessageComment,
  onMessageExcludeEntity,
  onMessageToggleTag,
  onMessageEdit,
  onOpenPointsOnMap,
}: DutyMessageCardItemProps) {
  const labels = buildMessageCardDisplayLabels(msg, { groupInfos, profiles });
  const etalonDisplayModel = resolveMessageCardEtalonDisplayModel(msg, {
    featureStrictNetworks,
    networkDisplayMap,
    networkMap,
    networks,
  });

  const messageComments = useMemo(
    () => filterOwnMessageComments(msg.messageComments, authUserName),
    [msg.messageComments, authUserName],
  );

  return (
    <DutyMessageCard
      id={id}
      msg={msg}
      analysisDestination="neo"
      feedCount={feedCount}
      tagsLayout={tagsLayout}
      botTagAction={botTagAction?.messageId === id ? botTagAction : null}
      onCancelBotTagAction={onCancelBotTagAction}
      onMarkBotTagWrong={onMarkBotTagWrong}
      referenceTimeMs={referenceTimeMs}
      authUserName={authUserName}
      tagContributionsOrganismId={tagContributionsOrganismId}
      groupName={labels.groupName}
      senderName={labels.senderName}
      copiedFeedbackId={copiedFeedbackId}
      networkDisplayMap={networkDisplayMap}
      messageComments={messageComments}
      networkMap={networkMap}
      unitsMap={unitsMap}
      callsignInfoMap={callsignInfoMap}
      networks={networks}
      featureStrictNetworks={featureStrictNetworks}
      tagsMap={tagsMap}
      tagsOrder={tagsOrder}
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
      onEditDetails={() => onMessageEdit(id, msg)}
      onOpenPointsOnMap={onOpenPointsOnMap}
      rightHeaderInsetPx={0}
      filterState={filterState}
    />
  );
});

// Repeated feed-list boundary: keep list and card wrappers lightweight.
// See ./AGENTS.md before adding structural component abstractions.
type DutyMessageListProps = {
  items: [number, InboxMessage][];
  feedId: string;
  feedCount?: number;
  tagsLayout: TagsLayoutVariant;
  botTagAction: MessageCardBotTagAction | null;
  onCancelBotTagAction: () => void;
  onMarkBotTagWrong: (messageId: number, tagId: number) => void | Promise<void>;
  referenceTimeMs: number | null;
  authUserName: string | null;
  tagContributionsOrganismId?: number;
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
  tagsOrder?: number[];
  filterState: RerDutyFeedFilterState;
  onMessageBookmark: (msgId: number, currentlyBookmarked: boolean) => void;
  onMessageImportant: (msgId: number, currentlyImportant: boolean) => void;
  onMessageCopy: (text: string, feedbackId: string) => void;
  onMessageAddFrequencyToFilter: (feedId: string, freq: string) => void;
  onMessageComment: (msgId: number, currentComment: string | null) => void;
  onMessageExcludeEntity: (entity: MessageEntityFilterKind, value: string) => void;
  onMessageToggleTag: (msgId: number, tagId: number) => void;
  onMessageEdit: (messageId: number, message: InboxMessage) => void;
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
  setItemRef: (id: number) => (node: HTMLDivElement | null) => void;
  listRef: React.RefObject<HTMLDivElement>;
};

const DutyMessageList = memo(function DutyMessageList({
  items,
  feedId,
  feedCount,
  tagsLayout,
  botTagAction,
  onCancelBotTagAction,
  onMarkBotTagWrong,
  referenceTimeMs,
  authUserName,
  tagContributionsOrganismId,
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
  tagsOrder,
  filterState,
  onMessageBookmark,
  onMessageImportant,
  onMessageCopy,
  onMessageAddFrequencyToFilter,
  onMessageComment,
  onMessageExcludeEntity,
  onMessageToggleTag,
  onMessageEdit,
  onOpenPointsOnMap,
  setItemRef,
  listRef,
}: DutyMessageListProps) {
  return (
    <div
      ref={listRef}
      data-duty-feed-list="true"
      className="m-0 list-none rer-duty pt-2"
      style={{ boxSizing: 'border-box' }}
    >
      {items.map(([id, msg]) => (
        <div key={id} ref={setItemRef(id)} data-duty-message-id={id}>
          <DutyMessageCardItem
            id={id}
            msg={msg}
            feedId={feedId}
            feedCount={feedCount}
            tagsLayout={tagsLayout}
            botTagAction={botTagAction}
            onCancelBotTagAction={onCancelBotTagAction}
            onMarkBotTagWrong={onMarkBotTagWrong}
            referenceTimeMs={referenceTimeMs}
            authUserName={authUserName}
            tagContributionsOrganismId={tagContributionsOrganismId}
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
            tagsOrder={tagsOrder}
            filterState={filterState}
            onMessageBookmark={onMessageBookmark}
            onMessageImportant={onMessageImportant}
            onMessageCopy={onMessageCopy}
            onMessageAddFrequencyToFilter={onMessageAddFrequencyToFilter}
            onMessageComment={onMessageComment}
            onMessageExcludeEntity={onMessageExcludeEntity}
            onMessageToggleTag={onMessageToggleTag}
            onMessageEdit={onMessageEdit}
            onOpenPointsOnMap={onOpenPointsOnMap}
          />
        </div>
      ))}
    </div>
  );
});

export const FeedColumnContent = memo(
  forwardRef<FeedColumnContentHandle, FeedColumnContentProps>(function FeedColumnContent(
    { column },
    ref,
  ) {
    const { feed, view, messageCard, actions } = column;
    const {
      narrowScreen = false,
      feedCount,
      scrollTrackingEnabled = true,
      loadingNewer = false,
      arrowResultMessage = null,
      bottomUnreadCount = 0,
      physicallyAtBottom = true,
      tailAvailability = 'unknown',
      isWatchMode = false,
      workspaceFabAvoidance = 'none',
    } = view;
    const {
      authUserName,
      tagContributionsOrganismId,
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
      onOpenPointsOnMap,
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
      onMessageEdit,
      onScrollToTop,
      onReachedBottom,
      onLeftBottom,
      onNearBottomChange,
      onAtBottomChange,
      onPhysicalBottomChange,
      onArrowClick,
      onVisibleMessageIds,
    } = actions;
    const [isPhysicallyAtBottom, setIsPhysicallyAtBottom] = useState(physicallyAtBottom);
    useLayoutEffect(() => {
      setIsPhysicallyAtBottom(physicallyAtBottom);
    }, [physicallyAtBottom]);
    const networks = useMemo(
      () => (networkMap ? Object.values(networkMap) : undefined),
      [networkMap],
    );
    const itemIds = useMemo(() => feed.items.map(([id]) => id), [feed.items]);
    const scroll = useWindowedFeedScroll({
      itemIds,
      debugFeedId: feed.id,
      isWatchMode,
      enabled: scrollTrackingEnabled,
      loadingOlder: feed.loadingOlder,
      loadingNewer,
      hasReachedStart: feed.hasReachedStart,
      onLoadOlder,
      onLoadNewer,
      onScrollToTop,
      onReachedBottom,
      onLeftBottom,
      onNearBottomChange,
      onAtBottomChange,
      onPhysicalBottomChange: (atBottom) => {
        setIsPhysicallyAtBottom(atBottom);
        onPhysicalBottomChange?.(atBottom);
      },
      onVisibleMessageIds,
      topLoadBufferPx: LOAD_OLDER_BUFFER_PX,
      bottomLoadBufferPx: LOAD_NEWER_BUFFER_PX,
      atBottomThresholdPx: DUTY_FEED_AT_BOTTOM_THRESHOLD_PX,
      resetKey: feed.referenceTimeMs ?? feed.id,
    });

    const stableOnCancelBotTagAction = useStableCallback(onCancelBotTagAction);
    const stableOnMarkBotTagWrong = useStableCallback(onMarkBotTagWrong);
    const stableOnMessageBookmark = useStableCallback(onMessageBookmark);
    const stableOnMessageImportant = useStableCallback(onMessageImportant);
    const stableOnMessageCopy = useStableCallback(onMessageCopy);
    const stableOnMessageAddFrequencyToFilter = useStableCallback(onMessageAddFrequencyToFilter);
    const stableOnMessageComment = useStableCallback(onMessageComment);
    const stableOnMessageExcludeEntity = useStableCallback(onMessageExcludeEntity);
    const stableOnMessageToggleTag = useStableCallback(onMessageToggleTag);
    const stableOnMessageEdit = useStableCallback(onMessageEdit);
    const stableOnOpenPointsOnMap = useStableCallback(onOpenPointsOnMap);
    const scrollFabPosition = resolveDutyScrollFabPosition({
      narrowScreen,
      workspaceFabAvoidance,
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
        data-duty-feed-content-root
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
            <DutyMessageList
              items={feed.items}
              feedId={feed.id}
              feedCount={feedCount}
              tagsLayout={tagsLayout}
              botTagAction={botTagAction}
              onCancelBotTagAction={stableOnCancelBotTagAction}
              onMarkBotTagWrong={stableOnMarkBotTagWrong}
              referenceTimeMs={feed.referenceTimeMs}
              authUserName={authUserName}
              tagContributionsOrganismId={tagContributionsOrganismId}
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
              tagsOrder={tagsOrder}
              filterState={feed.filter}
              onMessageBookmark={stableOnMessageBookmark}
              onMessageImportant={stableOnMessageImportant}
              onMessageCopy={stableOnMessageCopy}
              onMessageAddFrequencyToFilter={stableOnMessageAddFrequencyToFilter}
              onMessageComment={stableOnMessageComment}
              onMessageExcludeEntity={stableOnMessageExcludeEntity}
              onMessageToggleTag={stableOnMessageToggleTag}
              onMessageEdit={stableOnMessageEdit}
              onOpenPointsOnMap={onOpenPointsOnMap ? stableOnOpenPointsOnMap : undefined}
              setItemRef={scroll.setItemRef}
              listRef={scroll.listRef}
            />
          )}
        </Box>
        {feed.items.length > 0 &&
          isPresent(actions.onArrowClick) &&
          (loadingNewer || !isPhysicallyAtBottom || tailAvailability === 'available') && (
            <Box
              data-duty-feed-scroll-button
              data-duty-bottom-offset={String(scrollFabPosition.bottom)}
              data-duty-right-offset={String(scrollFabPosition.right)}
              style={{
                position: 'absolute',
                bottom: scrollFabPosition.bottom,
                right: scrollFabPosition.right,
              }}
              sx={{
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
                  color={bottomUnreadCount > 0 ? 'primary' : 'default'}
                  size="small"
                  sx={{
                    ...dutyTopScrollButtonSx,
                    position: 'relative',
                    zIndex: 0,
                    borderColor: bottomUnreadCount > 0 ? 'primary.main' : 'grey.400',
                    color: bottomUnreadCount > 0 ? 'primary.main' : 'grey.400',
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
                    <CircularProgress
                      size={20}
                      sx={{ color: 'primary.main' }}
                      aria-label="Завантаження нових повідомлень"
                    />
                  ) : (
                    <ArrowDownwardIcon sx={{ fontSize: 20 }} />
                  )}
                </Fab>
                {bottomUnreadCount > 0 && !isWatchMode && isNullOrUndefined(arrowResultMessage) && (
                  <PowerChip
                    size="small"
                    data-duty-scroll-unread-badge
                    label={bottomUnreadCount}
                    selected
                    interactive={false}
                    unselectedOpacity={1}
                    labelPaddingX={bottomUnreadCount < 10 ? 0 : undefined}
                    sx={{
                      position: 'absolute',
                      top: -6,
                      right: -6,
                      fontWeight: 600,
                      zIndex: 2,
                      pointerEvents: 'none',
                      ...(bottomUnreadCount < 10 && {
                        width: 20,
                        minWidth: 20,
                        height: 20,
                        minHeight: 20,
                        boxSizing: 'border-box',
                        borderRadius: '50%',
                      }),
                    }}
                  />
                )}
              </Box>
            </Box>
          )}
      </Paper>
    );
  }),
  (prevProps, nextProps) => {
    if (prevProps.column.feed !== nextProps.column.feed) {
      return false;
    }

    const prevView = prevProps.column.view;
    const nextView = nextProps.column.view;
    if (
      prevView.narrowScreen !== nextView.narrowScreen ||
      prevView.feedCount !== nextView.feedCount ||
      prevView.canRemove !== nextView.canRemove ||
      prevView.maxWidth !== nextView.maxWidth ||
      prevView.isWatchMode !== nextView.isWatchMode ||
      prevView.scrollTrackingEnabled !== nextView.scrollTrackingEnabled ||
      prevView.loadingNewer !== nextView.loadingNewer ||
      prevView.arrowResultMessage !== nextView.arrowResultMessage ||
      prevView.bottomUnreadCount !== nextView.bottomUnreadCount ||
      prevView.physicallyAtBottom !== nextView.physicallyAtBottom ||
      prevView.tailAvailability !== nextView.tailAvailability ||
      prevView.workspaceFabAvoidance !== nextView.workspaceFabAvoidance
    ) {
      return false;
    }

    const prevCard = prevProps.column.messageCard;
    const nextCard = nextProps.column.messageCard;
    if (
      prevCard.authUserName !== nextCard.authUserName ||
      prevCard.copiedFeedbackId !== nextCard.copiedFeedbackId ||
      prevCard.networkDisplayMap !== nextCard.networkDisplayMap ||
      prevCard.networkMap !== nextCard.networkMap ||
      prevCard.unitsMap !== nextCard.unitsMap ||
      prevCard.callsignInfoMap !== nextCard.callsignInfoMap ||
      prevCard.groupInfos !== nextCard.groupInfos ||
      prevCard.profiles !== nextCard.profiles ||
      prevCard.featureStrictNetworks !== nextCard.featureStrictNetworks ||
      prevCard.tagsLayout !== nextCard.tagsLayout ||
      prevCard.tagsMap !== nextCard.tagsMap ||
      prevCard.tagsOrder !== nextCard.tagsOrder ||
      prevCard.botTagAction !== nextCard.botTagAction ||
      prevCard.onOpenPointsOnMap !== nextCard.onOpenPointsOnMap
    ) {
      return false;
    }

    const prevActions = prevProps.column.actions;
    const nextActions = nextProps.column.actions;
    if (
      prevActions.onLoadOlder !== nextActions.onLoadOlder ||
      prevActions.onLoadNewer !== nextActions.onLoadNewer ||
      prevActions.onRemoveColumn !== nextActions.onRemoveColumn ||
      prevActions.onMessageBookmark !== nextActions.onMessageBookmark ||
      prevActions.onMessageImportant !== nextActions.onMessageImportant ||
      prevActions.onMessageAddFrequencyToFilter !== nextActions.onMessageAddFrequencyToFilter ||
      prevActions.onMessageCopy !== nextActions.onMessageCopy ||
      prevActions.onMessageComment !== nextActions.onMessageComment ||
      prevActions.onMessageExcludeEntity !== nextActions.onMessageExcludeEntity ||
      prevActions.onMessageToggleTag !== nextActions.onMessageToggleTag ||
      prevActions.onMessageEdit !== nextActions.onMessageEdit ||
      prevActions.onScrollToTop !== nextActions.onScrollToTop ||
      prevActions.onReachedBottom !== nextActions.onReachedBottom ||
      prevActions.onLeftBottom !== nextActions.onLeftBottom ||
      prevActions.onNearBottomChange !== nextActions.onNearBottomChange ||
      prevActions.onAtBottomChange !== nextActions.onAtBottomChange ||
      prevActions.onPhysicalBottomChange !== nextActions.onPhysicalBottomChange ||
      prevActions.onArrowClick !== nextActions.onArrowClick ||
      prevActions.onVisibleMessageIds !== nextActions.onVisibleMessageIds
    ) {
      return false;
    }

    return true;
  },
);
