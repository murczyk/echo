import { Box } from '@mui/material';
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

import type {
  CallsignInfoRes,
  Network,
  OrganismKeywordSetDto,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
} from '../../../../Bindings';
import type { TagsLayoutVariant, MessageFeedState } from './utils';
import type { FeedFilterPanelModel } from './FeedFilterPanel';
import {
  getStoredDutyNotificationSettingsForFeed,
  requestBrowserNotificationPermission,
  resumeDutyNotificationAudioFromUserGesture,
  setStoredDutyNotificationSettingsForFeed,
} from './notifications';
import { FeedColumnHeader } from './FeedColumnHeader';
import { FeedColumnContent } from './FeedColumnContent';
import { useDocumentClickAway } from '../../hooks/use-document-click-away';

export type FeedColumnModel = {
  feed: MessageFeedState;
  view: {
    /** Viewport below MUI `sm`: full-width columns, horizontal snap, flexible Virtuoso min-height. */
    narrowScreen?: boolean;
    /** Number of feeds (columns). Passed to MessageCard for header column shrink behavior. */
    feedCount?: number;
    canRemove: boolean;
    maxWidth?: string | number;
    isWatchMode?: boolean;
    loadingNewer?: boolean;
    arrowResultMessage?: string | null;
    unreadCount?: number;
  };
  filterPanel: FeedFilterPanelModel;
  keywordsPanel: {
    keywordSets: OrganismKeywordSetDto[];
    onFilterChange: (feedId: string, nextFilter: RerDutyFeedFilterState) => void;
  };
  messageCard: {
    /** Current auth user display name for message watermarks */
    authUserName: string | null;
    copiedFeedbackId: string | null;
    networkDisplayMap: Record<number, string>;
    networkMap: Record<number, Network>;
    unitsMap: Record<number, Unit>;
    callsignInfoMap: Record<string, CallsignInfoRes>;
    groupInfos: Record<string, SignalGroupEntry>;
    profiles: Record<string, SignalProfileEntry | null>;
    /** When true, empty network ids show "Не встановлена" only (no unit fallback). Server `featureStrictNetworks`. */
    featureStrictNetworks: boolean;
    tagsLayout: TagsLayoutVariant;
    tagsMap: Record<number, Tag>;
  };
  actions: {
    onLoadOlder: () => void;
    onRemoveColumn: () => void;
    onMessageBookmark: (msgId: number, currentlyBookmarked: boolean) => void;
    onMessageImportant: (msgId: number, currentlyImportant: boolean) => void;
    onMessageCopy: (text: string, feedbackId: string) => void;
    onMessageComment: (msgId: number, currentComment: string | null) => void;
    onMessageToggleTag: (msgId: number, tagId: number) => void;
    onScrollToTop?: () => void;
    /** Called when user scrolls to bottom; use to enable watch mode (same as after arrow click). */
    onReachedBottom?: () => void;
    /** Called when user scrolls away from bottom; use to disable watch mode so we don't load new messages. */
    onLeftBottom?: () => void;
    /** Called when the visible range enters or leaves the "near bottom" zone (within LOAD_OLDER_BUFFER_ITEMS of the end). Used so the poll can load newer when count > 0 and user is below buffer. */
    onNearBottomChange?: (near: boolean) => void;
    /** Virtuoso pixel at-bottom (see DUTY_FEED_AT_BOTTOM_THRESHOLD_PX); used so auto-scroll follow only runs when the scroller is actually at the bottom. */
    onAtBottomChange?: (atBottom: boolean) => void;
    onArrowClick?: () => void;
    /** Called when the visible range changes; pass message IDs in view so parent can add them to readIds. When user reaches bottom, called with all IDs and atBottom: true so badge clears. */
    onVisibleMessageIds?: (ids: number[], opts?: { atBottom?: boolean }) => void;
  };
};

export type FeedColumnProps = {
  column: FeedColumnModel;
};

export type FeedColumnHandle = { scrollToEnd: () => void };
export const FeedColumn = forwardRef<FeedColumnHandle, FeedColumnProps>(function FeedColumn({ column }, ref) {
  const { feed, view, filterPanel, keywordsPanel, actions } = column;
  const { narrowScreen = false, canRemove, maxWidth } = view;
  const { onRemoveColumn } = actions;
  const [showFilters, setShowFilters] = useState(false);
  const [showNotificationPanel, setShowNotificationPanel] = useState(false);
  const [showKeywordsPanel, setShowKeywordsPanel] = useState(false);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const filtersPanelRef = useRef<HTMLDivElement | null>(null);
  const notificationPanelRef = useRef<HTMLDivElement | null>(null);
  const keywordsPanelRef = useRef<HTMLDivElement | null>(null);
  const [notificationStorageSyncKey, setNotificationStorageSyncKey] = useState(0);
  const bumpNotificationStorageSync = useCallback(() => {
    setNotificationStorageSyncKey((k) => k + 1);
  }, []);
  const dutyNotificationSummary = useMemo(
    () => getStoredDutyNotificationSettingsForFeed(feed.id),
    [feed.id, notificationStorageSyncKey],
  );
  const dutyNotificationsOn = dutyNotificationSummary.soundEnabled || dutyNotificationSummary.browserEnabled;
  const handleBellToggleDutyNotifications = useCallback(
    async (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = getStoredDutyNotificationSettingsForFeed(feed.id);
      if (cur.soundEnabled || cur.browserEnabled) {
        setStoredDutyNotificationSettingsForFeed(feed.id, { soundEnabled: false, browserEnabled: false });
        bumpNotificationStorageSync();
        return;
      }
      resumeDutyNotificationAudioFromUserGesture();
      const permission = await requestBrowserNotificationPermission();
      const browserEnabled = permission === 'granted';
      setStoredDutyNotificationSettingsForFeed(feed.id, { soundEnabled: true, browserEnabled });
      bumpNotificationStorageSync();
    },
    [feed.id, bumpNotificationStorageSync],
  );
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const closeFilters = useCallback(() => {
    setShowFilters(false);
  }, []);
  const closeNotificationPanel = useCallback(() => {
    setShowNotificationPanel(false);
  }, []);
  const closeKeywordsPanel = useCallback(() => {
    setShowKeywordsPanel(false);
  }, []);
  useDocumentClickAway({
    enabled: showFilters,
    refs: [headerRef, filtersPanelRef],
    ignoreSelectors: ['.MuiModal-root', '.MuiPopover-root'],
    onClickAway: closeFilters,
  });
  useDocumentClickAway({
    enabled: showNotificationPanel,
    refs: [headerRef, notificationPanelRef],
    ignoreSelectors: ['.MuiModal-root', '.MuiPopover-root'],
    onClickAway: closeNotificationPanel,
  });
  useDocumentClickAway({
    enabled: showKeywordsPanel,
    refs: [headerRef, keywordsPanelRef],
    ignoreSelectors: ['.MuiModal-root', '.MuiPopover-root'],
    onClickAway: closeKeywordsPanel,
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd() {
        if (feed.items.length === 0) return;
        virtuosoRef.current?.scrollToIndex({
          index: feed.items.length - 1,
          align: 'end',
          behavior: 'smooth',
        });
      },
    }),
    [feed.items.length],
  );

  return (
    <Box
      className={[
        'flex flex-col min-w-0 gap-0 min-h-0 h-full',
        narrowScreen ? 'shrink-0 grow-0 basis-full' : 'shrink-0',
      ].join(' ')}
      sx={{
        width: maxWidth ?? '100%',
        maxWidth: maxWidth ?? '100%',
        position: 'relative',
        scrollSnapAlign: narrowScreen ? 'start' : undefined,
        scrollSnapStop: narrowScreen ? 'always' : undefined,
      }}
    >
      <FeedColumnHeader
        canRemove={canRemove}
        showFilters={showFilters}
        showNotificationPanel={showNotificationPanel}
        showKeywordsPanel={showKeywordsPanel}
        dutyNotificationsOn={dutyNotificationsOn}
        onToggleFilters={() => {
          setShowFilters((s) => !s);
          setShowNotificationPanel(false);
          setShowKeywordsPanel(false);
        }}
        onToggleNotificationPanel={() => {
          setShowNotificationPanel((s) => !s);
          setShowFilters(false);
          setShowKeywordsPanel(false);
        }}
        onToggleKeywordsPanel={() => {
          setShowKeywordsPanel((s) => !s);
          setShowFilters(false);
          setShowNotificationPanel(false);
        }}
        onToggleDutyNotifications={handleBellToggleDutyNotifications}
        onRemoveColumn={onRemoveColumn}
        headerRef={headerRef}
        filtersPanelRef={filtersPanelRef}
        notificationPanelRef={notificationPanelRef}
        keywordsPanelRef={keywordsPanelRef}
        filterPanel={filterPanel}
        feedId={feed.id}
        feedFilter={feed.filter}
        keywordsPanel={keywordsPanel}
        notificationStorageSyncKey={notificationStorageSyncKey}
        onNotificationPersisted={bumpNotificationStorageSync}
      />
      <FeedColumnContent column={column} virtuosoRef={virtuosoRef} />
    </Box>
  );
});
