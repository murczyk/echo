import { Box, Button, CircularProgress, Fab, IconButton, Paper, Typography } from '@mui/material';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import NotificationsOffOutlinedIcon from '@mui/icons-material/NotificationsOffOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ComponentProps, MouseEvent } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { isNullOrUndefined, isPresent } from '../../utils/misc';


import type {
  CallsignInfoRes,
  Network,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
} from '../../../../Bindings';
import type { TagsLayoutVariant } from './utils';
import { profileLabel } from './utils';
import type { MessageFeedState } from './utils';
import { FeedFilterPanel, type FeedFilterPanelModel } from './FeedFilterPanel';
import { FeedKeywordsPanel } from './FeedKeywordsPanel';
import { FeedNotificationPanel } from './FeedNotificationPanel';
import type {
  OrganismKeywordSetDto,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
} from '../../../../Bindings';
import {
  getStoredDutyNotificationSettingsForFeed,
  requestBrowserNotificationPermission,
  resumeDutyNotificationAudioFromUserGesture,
  setStoredDutyNotificationSettingsForFeed,
} from './notifications';
import { DutyMessageCard } from '../shared/message-card/MessageCard';
import { PowerChip } from '../../components/PowerChip';
import { dutyTopActionButtonSx, dutyTopScrollButtonSx } from './top-action-styles';

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
  const { feed, view, filterPanel, keywordsPanel, messageCard, actions } = column;
  const {
    narrowScreen = false,
    feedCount,
    canRemove,
    maxWidth,
    isWatchMode = false,
    loadingNewer = false,
    arrowResultMessage = null,
    unreadCount = 0,
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
    onRemoveColumn,
    onMessageBookmark,
    onMessageImportant,
    onMessageCopy,
    onMessageComment,
    onMessageToggleTag,
    onScrollToTop,
    onReachedBottom,
    onLeftBottom,
    onNearBottomChange,
    onAtBottomChange,
    onArrowClick,
    onVisibleMessageIds,
  } = actions;
  const [showFilters, setShowFilters] = useState(false);
  const [showNotificationPanel, setShowNotificationPanel] = useState(false);
  const [showKeywordsPanel, setShowKeywordsPanel] = useState(false);
  const [notificationStorageSyncKey, setNotificationStorageSyncKey] = useState(0);
  const bumpNotificationStorageSync = useCallback(() => {
    setNotificationStorageSyncKey((k) => k + 1);
  }, []);
  const dutyNotificationSummary = useMemo(
    () => getStoredDutyNotificationSettingsForFeed(feed.id),
    [feed.id, notificationStorageSyncKey],
  );
  const dutyNotificationsOn = dutyNotificationSummary.soundEnabled || dutyNotificationSummary.browserEnabled;
  const keywordsHighlightOn = feed.filter.highlightKeywordsEnabled ?? true;

  const handleKeywordsHighlightToggle = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      keywordsPanel.onFilterChange(feed.id, {
        ...feed.filter,
        highlightKeywordsEnabled: !keywordsHighlightOn,
      });
    },
    [feed.filter, feed.id, keywordsHighlightOn, keywordsPanel],
  );

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
  const [isAtBottom, setIsAtBottom] = useState(true);
  const loadOlderTriggeredRef = useRef(false);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  /** Only enable watch mode when user has scrolled to bottom, not when we're at bottom on initial render. */
  const hasSeenNotAtBottomRef = useRef(false);
  /** Last at-bottom value from Virtuoso; use for transition detection so we don't rely on stale state. */
  const atBottomRef = useRef(true);
  useEffect(() => {
    if (!feed.loadingOlder) loadOlderTriggeredRef.current = false;
  }, [feed.loadingOlder]);

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

  const tryLoadOlder = useCallback(() => {
    if (loadOlderTriggeredRef.current || feed.loadingOlder || feed.hasReachedStart) return;
    loadOlderTriggeredRef.current = true;
    onLoadOlder();
  }, [feed.loadingOlder, feed.hasReachedStart, onLoadOlder]);

  const nearBottomRef = useRef<boolean | null>(null);
  const firstItemIndex = feed.firstItemIndex ?? 0;
  const handleRangeChanged = useCallback(
    (range: { startIndex: number; endIndex: number }) => {
      const len = feed.items.length;
      // Range indices are in Virtuoso's total space (offset by firstItemIndex); convert to data indices
      const startDataIndex = range.startIndex - firstItemIndex;
      const endDataIndex = range.endIndex - firstItemIndex;
      // Near top: viewport top is within buffer of list start → trigger load older (paginate backward)
      const nearTop =
        len <= LOAD_OLDER_BUFFER_ITEMS ? len > 0 && startDataIndex <= 0 : startDataIndex < LOAD_OLDER_BUFFER_ITEMS;
      if (nearTop) {
        tryLoadOlder();
      } else if (startDataIndex > LOAD_OLDER_RESET_MARGIN) {
        // User scrolled away from top; allow load older to trigger again when they scroll back up
        loadOlderTriggeredRef.current = false;
      }
      // Near bottom: viewport bottom is within buffer of list end → tell parent for poll/load-newer
      const nearBottom =
        len <= LOAD_OLDER_BUFFER_ITEMS
          ? len > 0 && endDataIndex >= len - 1
          : endDataIndex >= len - LOAD_OLDER_BUFFER_ITEMS;
      if (nearBottomRef.current !== nearBottom) {
        nearBottomRef.current = nearBottom;
        onNearBottomChange?.(nearBottom);
      }
      // Report as read: all messages from start through bottom of viewport (everything "above" viewport is read by default)
      if (isPresent(onVisibleMessageIds) && len > 0) {
        const ids: number[] = [];
        for (let dataIndex = 0; dataIndex <= endDataIndex && dataIndex < len; dataIndex++) {
          ids.push(feed.items[dataIndex][0]);
        }
        if (ids.length > 0) onVisibleMessageIds(ids, { atBottom: false });
      }
    },
    [firstItemIndex, feed.items, feed.items.length, onNearBottomChange, onVisibleMessageIds, tryLoadOlder],
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
      <Box
        sx={{
          backgroundColor: 'background.paper',
          borderRadius: 0,
          border: '1px solid rgba(148, 163, 184, 0.28)',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <Box
          className="flex justify-between gap-2 flex-wrap text-sm items-stretch h-[32px] shrink-0"
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 1,
            backgroundColor: 'background.paper',
            overflow: 'hidden',
            borderBottomLeftRadius: 0,
            borderBottomRightRadius: 0,
            borderBottom: 'none',
            boxShadow: 'none',
            '& .MuiButton-root': {
              minHeight: 0,
              height: 32,
              maxHeight: 32,
              overflow: 'hidden',
            },
          }}
        >
          <Box className="flex min-w-0 items-stretch">
            <Button
              size="small"
              variant="text"
              className="self-stretch px-4"
              startIcon={<SettingsOutlinedIcon sx={{ color: 'inherit' }} />}
              endIcon={showFilters ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              onClick={() => {
                setShowFilters((s) => !s);
                setShowNotificationPanel(false);
                setShowKeywordsPanel(false);
              }}
              aria-expanded={showFilters}
              sx={{
                borderRadius: 0,
                color: showFilters ? 'primary.light' : 'text.secondary',
                backgroundColor: 'transparent',
                '&:hover': {
                  backgroundColor: 'action.hover',
                },
              }}
            >
              Фільтри
            </Button>
            <Box
              className="flex items-stretch self-stretch border-l border-solid"
              sx={{ borderColor: 'rgba(148, 163, 184, 0.28)' }}
            >
              <IconButton
                type="button"
                size="small"
                aria-label={
                  dutyNotificationsOn
                    ? 'Вимкнути звукові та браузерні сповіщення для стрічки'
                    : 'Увімкнути звукові та браузерні сповіщення для стрічки'
                }
                aria-pressed={dutyNotificationsOn}
                onClick={handleBellToggleDutyNotifications}
                sx={{
                  borderRadius: 0,
                  height: 32,
                  width: 40,
                  maxHeight: 32,
                  color: showNotificationPanel ? 'primary.light' : 'text.secondary',
                  '&:hover': { backgroundColor: 'action.hover' },
                }}
              >
                {dutyNotificationsOn ? (
                  <NotificationsActiveOutlinedIcon sx={{ fontSize: 20, color: 'inherit' }} />
                ) : (
                  <Box
                    component="span"
                    sx={{
                      position: 'relative',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 22,
                      height: 22,
                    }}
                  >
                    <NotificationsOffOutlinedIcon sx={{ fontSize: 20, color: 'inherit' }} />
                  </Box>
                )}
              </IconButton>
              <Button
                size="small"
                variant="text"
                className="self-stretch px-2 min-w-0"
                endIcon={showNotificationPanel ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                onClick={() => {
                  setShowNotificationPanel((s) => !s);
                  setShowFilters(false);
                  setShowKeywordsPanel(false);
                }}
                aria-expanded={showNotificationPanel}
                sx={{
                  borderRadius: 0,
                  color: showNotificationPanel ? 'primary.light' : 'text.secondary',
                  backgroundColor: 'transparent',
                  '&:hover': {
                    backgroundColor: 'action.hover',
                  },
                }}
              >
                Сповіщення
              </Button>
            </Box>
            <Box
              className="flex items-stretch self-stretch border-l border-solid"
              sx={{ borderColor: 'rgba(148, 163, 184, 0.28)' }}
            >
              <IconButton
                type="button"
                size="small"
                aria-label={
                  keywordsHighlightOn
                    ? 'Вимкнути підсвічування ключових слів'
                    : 'Увімкнути підсвічування ключових слів'
                }
                aria-pressed={keywordsHighlightOn}
                onClick={handleKeywordsHighlightToggle}
                sx={{
                  borderRadius: 0,
                  height: 32,
                  width: 40,
                  maxHeight: 32,
                  color: showKeywordsPanel ? 'primary.light' : 'text.secondary',
                  '&:hover': { backgroundColor: 'action.hover' },
                }}
              >
                <KeyOutlinedIcon sx={{ fontSize: 20, color: 'inherit' }} />
              </IconButton>
              <Button
                size="small"
                variant="text"
                className="self-stretch px-2 min-w-0"
                endIcon={showKeywordsPanel ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                onClick={() => {
                  setShowKeywordsPanel((s) => !s);
                  setShowFilters(false);
                  setShowNotificationPanel(false);
                }}
                aria-expanded={showKeywordsPanel}
                sx={{
                  borderRadius: 0,
                  color: showKeywordsPanel ? 'primary.light' : 'text.secondary',
                  backgroundColor: 'transparent',
                  '&:hover': {
                    backgroundColor: 'action.hover',
                  },
                }}
              >
                Ключові слова
              </Button>
            </Box>
          </Box>
          {canRemove && (
            <Button
              size="small"
              color="inherit"
              aria-label="Закрити колонку"
              onClick={onRemoveColumn}
              sx={dutyTopActionButtonSx}
            >
              <CloseIcon />
            </Button>
          )}
        </Box>
        {showFilters && (
          <Box>
            <FeedFilterPanel panel={filterPanel} />
          </Box>
        )}
        {showNotificationPanel && (
          <Box>
            <FeedNotificationPanel
              feedId={feed.id}
              storageSyncKey={notificationStorageSyncKey}
              onPersisted={bumpNotificationStorageSync}
            />
          </Box>
        )}
        {showKeywordsPanel && (
          <Box>
            <FeedKeywordsPanel
              feedId={feed.id}
              filter={feed.filter}
              keywordSets={keywordsPanel.keywordSets}
              onFilterChange={keywordsPanel.onFilterChange}
            />
          </Box>
        )}
      </Box>

      {feed.loading ? (
        <Box className="flex-1 flex justify-center items-center min-h-0">
          <CircularProgress />
        </Box>
      ) : (
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
            ref={virtuosoRef}
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
                    <Typography variant="body2">Завантаження старіших…</Typography>
                  </Box>
                ) : feed.hasReachedStart ? (
                  <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 1.5 }}>
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
              const senderName = isPresent(msg.sender) ? profileLabel(msg.sender, profiles[msg.sender] ?? null) : null;
              const groupName = isPresent(msg.groupMasterKey) ? (groupInfos[msg.groupMasterKey]?.name ?? null) : null;
              return (
                <DutyMessageCard
                  id={id}
                  msg={msg}
                  feedCount={feedCount}
                  tagsLayout={tagsLayout}
                  referenceTimeMs={feed.referenceTimeMs}
                  authUserName={authUserName}
                  groupName={groupName}
                  senderName={senderName}
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
                  onComment={() => onMessageComment(id, msg.extendedForm ?? null)}
                  onToggleTag={(tagId) => onMessageToggleTag(id, tagId)}
                  rightHeaderInsetPx={0}
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
                {!loadingNewer && unreadCount > 0 && !isWatchMode && isNullOrUndefined(arrowResultMessage) && (
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
      )}
    </Box>
  );
});
