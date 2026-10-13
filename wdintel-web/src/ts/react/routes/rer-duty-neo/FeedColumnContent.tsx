import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { Box, CircularProgress, Fab, Paper, Typography } from '@mui/material';
import {
  forwardRef,
  memo,
  Profiler,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import type { ProfilerOnRenderCallback } from 'react';
import { flushSync } from 'react-dom';
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
import { isNullOrUndefined, isPresent } from '../../utils/misc';
import type { FeedColumnModel } from './types';
import { resolveDutyScrollFabPosition } from './duty-scroll-fab-position';
import { PowerChip } from '../../components/PowerChip';
import { DutyMessageCard } from '../shared/message-card/MessageCard';
import type { MessageCardBotTagAction } from '../shared/message-card/message-card.types';
import type { AddPointHighlightBlacklistRequest } from '../shared/message-card/point-highlight-blacklist';
import type { MessageTextPreviewLineLimit } from '../../services/api/user-settings';
import { buildMessageCardDisplayLabels } from '../shared/message-card/message-card-labels';
import {
  buildCopyTextWithNetworkAndNote,
  buildCopyTextWithNetworkName,
  buildMessageLinkFullUrl,
  resolveMessageCardEtalonDisplayModel,
  type MessageCardEtalonDisplayModel,
} from '../shared/message-card/message-card.utils';
import type { MessageEntityFilterKind, TagsLayoutVariant } from './utils';
import { feedHasUnrenderedHistoricalNewer, feedListRenderStateEqual } from './utils';
import { dutyTopScrollButtonSx } from './top-action-styles';
import {
  MessageFeed,
  MessageFeedItem,
  MessageFeedRows,
  ScrollNavigationIntent,
  shouldShowNewestNavigation,
  type AnchorSnapshot,
  type ExplicitScrollNavigation,
  type MessageFeedHandle,
  type MessageFeedPolicy,
} from '../shared/message-feed';
import { useFeedIdleViewportOffload } from './useFeedIdleViewportOffload';
import {
  recordDutyScrollDebugEvent,
  recordDutyScrollDebugMetrics,
  recordDutyScrollDebugTiming,
  useDutyScrollDebugEnabled,
} from './duty-scroll-debug';
import { useFeedColumnFab } from './feedColumnFab';
import { DEFAULT_MEDIA_SUMMARY_ENABLED } from '../../hooks/duty-settings-defaults';

/** Fallback top-edge threshold when no older-page skeleton is present. */
const LOAD_OLDER_BUFFER_PX = 160;
/** Near-bottom threshold for unread prefetch and pending tail handling. */
const LOAD_NEWER_BUFFER_PX = 640;
/** Consider "at bottom" when within this many pixels of the scroll end (watch mode / read-state). */
const DUTY_FEED_AT_BOTTOM_THRESHOLD_PX = 25;
const DUTY_FEED_POLICY: MessageFeedPolicy = {
  initialPosition: 'end',
  followAtBottom: true,
  aboveLoadBufferPx: LOAD_OLDER_BUFFER_PX,
  belowLoadBufferPx: LOAD_NEWER_BUFFER_PX,
  atBottomThresholdPx: DUTY_FEED_AT_BOTTOM_THRESHOLD_PX,
  underfilledEdgeLoading: true,
};
const getMessageId = ([id]: [number, InboxMessage]) => id;
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

export type FeedColumnContentScrollOptions = {
  /** Wake idle offload before scrolling (scroll FAB / arrow). Follow/settle omit this. */
  wakeIdleOffload?: boolean;
  intent?: ScrollNavigationIntent;
  navigation?: ExplicitScrollNavigation;
};

export type FeedColumnContentHandle = {
  scrollToBottom: (behavior?: ScrollBehavior, options?: FeedColumnContentScrollOptions) => void;
  scrollToMessage: (id: number, behavior?: ScrollBehavior) => HTMLElement | null;
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
  hideBotTags: boolean;
  hideNetworks: boolean;
  collapseMediaPreviews?: boolean;
  mediaSummaryEnabled?: boolean;
  messageTextPreviewLines: MessageTextPreviewLineLimit;
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
  onMessageCreateReport: (
    msgId: number,
    message: InboxMessage,
    etalonDisplayModel: MessageCardEtalonDisplayModel,
    focusTarget: HTMLElement,
  ) => void;
  onMessageEditReport: (reportId: number) => void;
  onMessageExcludeEntity: (entity: MessageEntityFilterKind, value: string) => void;
  onMessageToggleTag: (msgId: number, tagId: number) => void;
  onMessageEdit: (messageId: number, message: InboxMessage, focusTarget?: HTMLElement) => void;
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
  onAddPointHighlightBlacklist?: (request: AddPointHighlightBlacklistRequest) => Promise<void>;
};

const DutyMessageCardItem = memo(function DutyMessageCardItem({
  id,
  msg,
  feedId,
  feedCount,
  tagsLayout,
  hideBotTags,
  hideNetworks,
  collapseMediaPreviews = false,
  mediaSummaryEnabled = DEFAULT_MEDIA_SUMMARY_ENABLED,
  messageTextPreviewLines,
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
  onMessageCreateReport,
  onMessageEditReport,
  onMessageExcludeEntity,
  onMessageToggleTag,
  onMessageEdit,
  onOpenPointsOnMap,
  onAddPointHighlightBlacklist,
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
      hideBotTags={hideBotTags}
      hideNetworks={hideNetworks}
      collapseMediaPreviews={collapseMediaPreviews}
      mediaSummaryEnabled={mediaSummaryEnabled}
      messageTextPreviewLines={messageTextPreviewLines}
      messageTimeBasis="creation"
      botTagAction={botTagAction?.messageId === id ? botTagAction : null}
      onCancelBotTagAction={onCancelBotTagAction}
      onMarkBotTagWrong={onMarkBotTagWrong}
      referenceTimeMs={referenceTimeMs}
      authUserName={authUserName}
      tagContributionsOrganismId={tagContributionsOrganismId}
      groupName={labels.groupName}
      reportGroupInfos={groupInfos}
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
      onCopyMessageLink={() =>
        onMessageCopy(buildMessageLinkFullUrl(msg, 'duty', id), `link-${id}`)
      }
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
      onCopyEtalon={(value) => onMessageCopy(value, `etalon-${id}`)}
      onCopyLocation={(value) => onMessageCopy(value, `location-${id}`)}
      onCreateReport={(visibleEtalonDisplayModel, focusTarget) =>
        onMessageCreateReport(id, msg, visibleEtalonDisplayModel, focusTarget)
      }
      onEditReport={onMessageEditReport}
      onExcludeMessageEntity={(entity, value) => onMessageExcludeEntity(entity, value)}
      onToggleTag={(tagId) => onMessageToggleTag(id, tagId)}
      onEditDetails={(focusTarget) => onMessageEdit(id, msg, focusTarget)}
      onOpenPointsOnMap={onOpenPointsOnMap}
      onAddPointHighlightBlacklist={onAddPointHighlightBlacklist}
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
  hideBotTags: boolean;
  hideNetworks: boolean;
  collapseMediaPreviews?: boolean;
  mediaSummaryEnabled?: boolean;
  messageTextPreviewLines: MessageTextPreviewLineLimit;
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
  onMessageCreateReport: (
    msgId: number,
    message: InboxMessage,
    etalonDisplayModel: MessageCardEtalonDisplayModel,
    focusTarget: HTMLElement,
  ) => void;
  onMessageEditReport: (reportId: number) => void;
  onMessageExcludeEntity: (entity: MessageEntityFilterKind, value: string) => void;
  onMessageToggleTag: (msgId: number, tagId: number) => void;
  onMessageEdit: (messageId: number, message: InboxMessage, focusTarget?: HTMLElement) => void;
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
  onAddPointHighlightBlacklist?: (request: AddPointHighlightBlacklistRequest) => Promise<void>;
  /** When non-null, only these ids mount MessageCards; others use height placeholders. */
  mountedItemIds: Set<number> | null;
  placeholderHeightPx: (id: number) => number;
};

const DutyMessageList = memo(
  function DutyMessageList({
    items,
    feedId,
    feedCount,
    tagsLayout,
    hideBotTags,
    hideNetworks,
    collapseMediaPreviews = false,
    mediaSummaryEnabled = DEFAULT_MEDIA_SUMMARY_ENABLED,
    messageTextPreviewLines,
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
    onMessageCreateReport,
    onMessageEditReport,
    onMessageExcludeEntity,
    onMessageToggleTag,
    onMessageEdit,
    onOpenPointsOnMap,
    onAddPointHighlightBlacklist,
    mountedItemIds,
    placeholderHeightPx,
  }: DutyMessageListProps) {
    return (
      <MessageFeedRows
        items={items}
        getMessageId={getMessageId}
        renderMessage={([id, msg]) => {
          const mountCard = mountedItemIds == null || mountedItemIds.has(id);
          return (
            <MessageFeedItem id={id} data-duty-message-id={id}>
              {mountCard ? (
                <DutyMessageCardItem
                  id={id}
                  msg={msg}
                  feedId={feedId}
                  feedCount={feedCount}
                  tagsLayout={tagsLayout}
                  hideBotTags={hideBotTags}
                  hideNetworks={hideNetworks}
                  collapseMediaPreviews={collapseMediaPreviews}
                  mediaSummaryEnabled={mediaSummaryEnabled}
                  messageTextPreviewLines={messageTextPreviewLines}
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
                  onMessageCreateReport={onMessageCreateReport}
                  onMessageEditReport={onMessageEditReport}
                  onMessageExcludeEntity={onMessageExcludeEntity}
                  onMessageToggleTag={onMessageToggleTag}
                  onMessageEdit={onMessageEdit}
                  onOpenPointsOnMap={onOpenPointsOnMap}
                  onAddPointHighlightBlacklist={onAddPointHighlightBlacklist}
                />
              ) : (
                <div
                  aria-hidden
                  data-duty-message-placeholder="true"
                  style={{ height: placeholderHeightPx(id) }}
                />
              )}
            </MessageFeedItem>
          );
        }}
      />
    );
  },
  (prev, next) =>
    prev.items === next.items &&
    prev.feedId === next.feedId &&
    prev.feedCount === next.feedCount &&
    prev.tagsLayout === next.tagsLayout &&
    prev.hideBotTags === next.hideBotTags &&
    prev.hideNetworks === next.hideNetworks &&
    prev.collapseMediaPreviews === next.collapseMediaPreviews &&
    prev.messageTextPreviewLines === next.messageTextPreviewLines &&
    prev.botTagAction === next.botTagAction &&
    prev.onCancelBotTagAction === next.onCancelBotTagAction &&
    prev.onMarkBotTagWrong === next.onMarkBotTagWrong &&
    prev.referenceTimeMs === next.referenceTimeMs &&
    prev.authUserName === next.authUserName &&
    prev.tagContributionsOrganismId === next.tagContributionsOrganismId &&
    prev.groupInfos === next.groupInfos &&
    prev.profiles === next.profiles &&
    prev.copiedFeedbackId === next.copiedFeedbackId &&
    prev.networkDisplayMap === next.networkDisplayMap &&
    prev.networkMap === next.networkMap &&
    prev.unitsMap === next.unitsMap &&
    prev.callsignInfoMap === next.callsignInfoMap &&
    prev.networks === next.networks &&
    prev.featureStrictNetworks === next.featureStrictNetworks &&
    prev.tagsMap === next.tagsMap &&
    prev.tagsOrder === next.tagsOrder &&
    prev.filterState === next.filterState &&
    prev.onMessageBookmark === next.onMessageBookmark &&
    prev.onMessageImportant === next.onMessageImportant &&
    prev.onMessageCopy === next.onMessageCopy &&
    prev.onMessageCreateReport === next.onMessageCreateReport &&
    prev.onMessageEditReport === next.onMessageEditReport &&
    prev.onMessageExcludeEntity === next.onMessageExcludeEntity &&
    prev.onMessageToggleTag === next.onMessageToggleTag &&
    prev.onMessageEdit === next.onMessageEdit &&
    prev.onOpenPointsOnMap === next.onOpenPointsOnMap &&
    prev.onAddPointHighlightBlacklist === next.onAddPointHighlightBlacklist &&
    prev.mountedItemIds === next.mountedItemIds &&
    prev.placeholderHeightPx === next.placeholderHeightPx,
);

type FeedColumnScrollFabProps = {
  feedId: string;
  loadingNewer: boolean;
  isWatchMode: boolean;
  atNewestEdge: boolean;
  hasItems: boolean;
  bottom: number | string;
  right: number | string;
  onArrowClick?: () => void;
};

const FeedColumnScrollFab = memo(function FeedColumnScrollFab({
  feedId,
  loadingNewer,
  isWatchMode,
  atNewestEdge,
  hasItems,
  bottom,
  right,
  onArrowClick,
}: FeedColumnScrollFabProps) {
  const {
    bottomUnreadCount,
    arrowResultMessage,
    tailAvailability,
    hasUnrenderedNewerMessages,
    explicitNavigationLoading,
  } = useFeedColumnFab(feedId);
  const newestLoaded =
    tailAvailability === 'exhausted' && !hasUnrenderedNewerMessages && !loadingNewer;
  if (
    !hasItems ||
    !isPresent(onArrowClick) ||
    !shouldShowNewestNavigation(atNewestEdge, newestLoaded)
  ) {
    return null;
  }
  return (
    <Box
      data-duty-feed-scroll-button
      data-duty-bottom-offset={String(bottom)}
      data-duty-right-offset={String(right)}
      style={{
        position: 'absolute',
        bottom,
        right,
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
          aria-label={isWatchMode ? 'Режим перегляду нових' : 'Завантажити нові та перейти вниз'}
          onClick={onArrowClick}
          disabled={loadingNewer}
        >
          {loadingNewer && explicitNavigationLoading ? (
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
  );
});

export const FeedColumnContent = memo(
  forwardRef<FeedColumnContentHandle, FeedColumnContentProps>(function FeedColumnContent(
    { column },
    ref,
  ) {
    const { feed, view, messageCard, actions } = column;
    const debugEnabled = useDutyScrollDebugEnabled();
    const onDebugRender = useCallback<ProfilerOnRenderCallback>(
      (_id, phase, actualDuration) => {
        recordDutyScrollDebugTiming(feed.id, {
          phase: 'render',
          durationMs: actualDuration,
          reason: phase,
        });
      },
      [feed.id],
    );
    const {
      narrowScreen = false,
      feedCount,
      scrollTrackingEnabled = true,
      loadingNewer = false,
      isWatchMode = false,
      autoScrollAllowed = false,
      initialPositioningReady = true,
      unreadPrefetchNeeded = true,
      pendingNewerFlushNeeded = false,
      workspaceFabAvoidance = 'none',
      initialScrollAnchorSnapshot = null,
      onScrollAnchorSnapshotChange,
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
      hideBotTags,
      hideNetworks,
      collapseMediaPreviews = false,
      mediaSummaryEnabled = DEFAULT_MEDIA_SUMMARY_ENABLED,
      messageTextPreviewLines,
      tagsMap,
      tagsOrder,
      botTagAction,
      onCancelBotTagAction,
      onMarkBotTagWrong,
      onOpenPointsOnMap,
      onAddPointHighlightBlacklist,
    } = messageCard;
    const {
      onLoadOlder,
      onLoadNewer,
      onFlushPendingNewer,
      onMessageBookmark,
      onMessageImportant,
      onMessageCopy,
      onMessageCreateReport,
      onMessageEditReport,
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
    const networks = useMemo(
      () => (networkMap ? Object.values(networkMap) : undefined),
      [networkMap],
    );
    const itemIds = useMemo(() => feed.items.map(([id]) => id), [feed.items]);
    const handleAnchorSnapshotChange = useCallback(
      (snapshot: AnchorSnapshot | null) => {
        onScrollAnchorSnapshotChange?.(feed.id, snapshot);
      },
      [feed.id, onScrollAnchorSnapshotChange],
    );
    const feedRef = useRef<MessageFeedHandle>(null);
    const scrollerRef = useRef<HTMLDivElement>(null);
    const scrollOptions = {
      policy: DUTY_FEED_POLICY,
      diagnostics: {
        enabled: debugEnabled,
        event: recordDutyScrollDebugEvent,
        metrics: recordDutyScrollDebugMetrics,
      },
      initialAnchorSnapshot: initialScrollAnchorSnapshot,
      onAnchorSnapshotChange: handleAnchorSnapshotChange,
      debugFeedId: feed.id,
      isWatchMode,
      autoScrollAllowed,
      initialPositioningReady,
      enabled: scrollTrackingEnabled,
      hasReachedStart: feed.hasReachedStart,
      onLoadOlder,
      onLoadNewer,
      onFlushPendingNewer,
      onScrollToTop,
      onReachedBottom,
      onLeftBottom,
      onNearBottomChange,
      onAtBottomChange,
      onPhysicalBottomChange,
      onVisibleMessageIds,
      resetKey: feed.referenceTimeMs ?? feed.id,
      unreadPrefetchNeeded,
      pendingNewerFlushNeeded,
    };
    const idleOffload = useFeedIdleViewportOffload({
      // Multi-feed only: single-column Duty already fits; idle offload is for sibling columns.
      enabled: scrollTrackingEnabled && (feedCount ?? 1) >= 2,
      scrollerRef,
      itemIds,
    });

    const stableOnCancelBotTagAction = useStableCallback(onCancelBotTagAction);
    const stableOnMarkBotTagWrong = useStableCallback(onMarkBotTagWrong);
    const stableOnMessageBookmark = useStableCallback(onMessageBookmark);
    const stableOnMessageImportant = useStableCallback(onMessageImportant);
    const stableOnMessageCopy = useStableCallback(onMessageCopy);
    const stableOnMessageCreateReport = useStableCallback(onMessageCreateReport);
    const stableOnMessageEditReport = useStableCallback(onMessageEditReport);
    const stableOnMessageExcludeEntity = useStableCallback(onMessageExcludeEntity);
    const stableOnMessageToggleTag = useStableCallback(onMessageToggleTag);
    const stableOnMessageEdit = useStableCallback(onMessageEdit);
    const stableOnOpenPointsOnMap = useStableCallback(onOpenPointsOnMap);
    const stableOnAddPointHighlightBlacklist = useStableCallback(onAddPointHighlightBlacklist);
    const scrollFabPosition = resolveDutyScrollFabPosition({
      narrowScreen,
      workspaceFabAvoidance,
    });

    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom: (behavior?: ScrollBehavior, options?: FeedColumnContentScrollOptions) => {
          if (options?.wakeIdleOffload === true) {
            // Remount cards before moving the viewport or the FAB lands on placeholders.
            flushSync(() => {
              idleOffload.wakeFromOffload();
            });
          }
          feedRef.current?.scrollToBottom(behavior, options?.intent, options?.navigation);
        },
        scrollToMessage: (id: number, behavior: ScrollBehavior = 'auto') => {
          flushSync(() => {
            idleOffload.wakeFromOffload();
          });
          return feedRef.current?.scrollToMessage(id, behavior) ?? null;
        },
      }),
      [idleOffload.wakeFromOffload],
    );

    const messageList =
      feed.items.length === 0 && !feed.loading ? (
        <Typography color="text.secondary" className="p-4">
          Немає повідомлень
        </Typography>
      ) : (
        <DutyMessageList
          items={feed.items}
          feedId={feed.id}
          feedCount={feedCount}
          tagsLayout={tagsLayout}
          hideBotTags={hideBotTags}
          hideNetworks={hideNetworks}
          collapseMediaPreviews={collapseMediaPreviews}
          mediaSummaryEnabled={mediaSummaryEnabled}
          messageTextPreviewLines={messageTextPreviewLines}
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
          onMessageCreateReport={stableOnMessageCreateReport}
          onMessageEditReport={stableOnMessageEditReport}
          onMessageExcludeEntity={stableOnMessageExcludeEntity}
          onMessageToggleTag={stableOnMessageToggleTag}
          onMessageEdit={stableOnMessageEdit}
          onOpenPointsOnMap={onOpenPointsOnMap ? stableOnOpenPointsOnMap : undefined}
          onAddPointHighlightBlacklist={
            onAddPointHighlightBlacklist ? stableOnAddPointHighlightBlacklist : undefined
          }
          mountedItemIds={idleOffload.mountedItemIds}
          placeholderHeightPx={idleOffload.placeholderHeightPx}
        />
      );
    const profiledMessageList =
      debugEnabled && feed.items.length > 0 ? (
        <Profiler id={`duty-feed-list-${feed.id}`} onRender={onDebugRender}>
          {messageList}
        </Profiler>
      ) : (
        messageList
      );

    return (
      <Paper
        data-duty-feed-content-root
        variant="outlined"
        className="flex-1 overflow-hidden min-h-0 p-0 flex flex-col h-full"
        sx={{
          mt: '-1px',
          bgcolor: narrowScreen ? 'transparent' : undefined,
          border: narrowScreen ? 0 : undefined,
          borderTopLeftRadius: 0,
          borderTopRightRadius: 0,
          position: 'relative',
          zIndex: 0,
          isolation: 'isolate',
        }}
      >
        <MessageFeed
          ref={feedRef}
          scrollerRef={scrollerRef}
          scrollOptions={scrollOptions}
          newestNavigation={{
            edge: 'bottom',
            renderControl: (atNewestEdge) => (
              <FeedColumnScrollFab
                feedId={feed.id}
                loadingNewer={loadingNewer}
                isWatchMode={isWatchMode}
                atNewestEdge={atNewestEdge}
                hasItems={feed.items.length > 0}
                bottom={scrollFabPosition.bottom}
                right={scrollFabPosition.right}
                onArrowClick={onArrowClick}
              />
            ),
          }}
          items={feed.items}
          getMessageId={getMessageId}
          isLoading={feed.loading}
          loadingAbove={feed.loadingOlder}
          loadingBelow={loadingNewer}
          hasMoreAbove={!feed.hasReachedStart}
          hasMoreBelow={
            (feed.evictedNewerTailId != null &&
              feed.items.every(([id]) => id !== feed.evictedNewerTailId)) ||
            feedHasUnrenderedHistoricalNewer(feed)
          }
          itemSelector="[data-duty-message-id]"
          scrollerProps={{
            'data-duty-feed-scroller': 'true',
            className: 'rer-duty-feed-scroll',
            tabIndex: 0,
            style: { flex: 1, minHeight: narrowScreen ? 0 : 400, scrollbarGutter: 'stable' },
          }}
          listProps={{
            'data-duty-feed-list': 'true',
            'data-duty-idle-offload': idleOffload.mountedItemIds != null ? 'true' : undefined,
            className: 'm-0 list-none rer-duty pt-2 px-echo-md',
          }}
          beforeList={
            !feed.loadingOlder && feed.hasReachedStart ? (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ textAlign: 'center', py: 1.5 }}
              >
                Немає старіших повідомлень
              </Typography>
            ) : null
          }
        >
          {profiledMessageList}
        </MessageFeed>
      </Paper>
    );
  }),
  (prevProps, nextProps) => {
    if (!feedListRenderStateEqual(prevProps.column.feed, nextProps.column.feed)) {
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
      prevView.autoScrollAllowed !== nextView.autoScrollAllowed ||
      prevView.initialPositioningReady !== nextView.initialPositioningReady ||
      prevView.scrollTrackingEnabled !== nextView.scrollTrackingEnabled ||
      prevView.loadingNewer !== nextView.loadingNewer ||
      prevView.unreadPrefetchNeeded !== nextView.unreadPrefetchNeeded ||
      prevView.pendingNewerFlushNeeded !== nextView.pendingNewerFlushNeeded ||
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
      prevCard.hideBotTags !== nextCard.hideBotTags ||
      prevCard.hideNetworks !== nextCard.hideNetworks ||
      prevCard.collapseMediaPreviews !== nextCard.collapseMediaPreviews ||
      prevCard.messageTextPreviewLines !== nextCard.messageTextPreviewLines ||
      prevCard.tagsMap !== nextCard.tagsMap ||
      prevCard.tagsOrder !== nextCard.tagsOrder ||
      prevCard.botTagAction !== nextCard.botTagAction ||
      prevCard.onOpenPointsOnMap !== nextCard.onOpenPointsOnMap ||
      prevCard.onAddPointHighlightBlacklist !== nextCard.onAddPointHighlightBlacklist ||
      prevCard.tagContributionsOrganismId !== nextCard.tagContributionsOrganismId
    ) {
      return false;
    }

    const prevActions = prevProps.column.actions;
    const nextActions = nextProps.column.actions;
    if (
      prevActions.onLoadOlder !== nextActions.onLoadOlder ||
      prevActions.onLoadNewer !== nextActions.onLoadNewer ||
      prevActions.onFlushPendingNewer !== nextActions.onFlushPendingNewer ||
      prevActions.onRemoveColumn !== nextActions.onRemoveColumn ||
      prevActions.onMessageBookmark !== nextActions.onMessageBookmark ||
      prevActions.onMessageImportant !== nextActions.onMessageImportant ||
      prevActions.onMessageCopy !== nextActions.onMessageCopy ||
      prevActions.onMessageCreateReport !== nextActions.onMessageCreateReport ||
      prevActions.onMessageEditReport !== nextActions.onMessageEditReport ||
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
