import { Box, Button, CircularProgress, Fab, Paper, Typography } from '@mui/material';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import type {
  Network,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SavedFilterDuty,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
} from '../../../../Bindings';
import type { TagsLayoutVariant } from './utils';
import { profileLabel } from './utils';
import type { MessageFeedState } from './utils';
import { FeedFilterPanel } from './FeedFilterPanel';
import { MessageCard } from './MessageCard';
import { PowerChip } from '../../components/PowerChip';

/** When the visible range enters this many items from the bottom (oldest at top, newest at bottom), load 20 older messages to keep scroll position and unread count. */
const LOAD_OLDER_BUFFER_ITEMS = 10;
/** After loading older, don't trigger again until the user scrolls back up so the visible range is at least this far from the bottom. */
const LOAD_OLDER_RESET_MARGIN = 20;

const FeedScroller = forwardRef<HTMLDivElement, ComponentProps<'div'>>(function FeedScroller(
  { style, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-virtuoso-scroller
      style={{ ...style, paddingLeft: 12 }}
      className={[className, 'rer-duty-feed-scroll'].filter(Boolean).join(' ')}
      {...props}
    />
  );
});

export type FeedColumnProps = {
  feed: MessageFeedState;
  /** Number of feeds (columns). Passed to MessageCard for header column shrink behavior. */
  feedCount?: number;
  filterStable: {
    groupsSelected: string[];
    sendersSelected: string[];
    deniedSenders: string[];
    freqsSelected: string[];
    freqsDenied: string[];
    postsSelected: string[];
    postsDenied: string[];
  };
  groupsList: string[];
  groupInfos: Record<string, SignalGroupEntry>;
  profiles: Record<string, SignalProfileEntry | null>;
  senderOptions: Array<{ id: string; label: string }>;
  freqs: string[];
  postsList: string[];
  adjacentFreqsRange: number;
  highlightSignalsEnabled: boolean;
  onlyMyUnitTagsEnabled: boolean;
  messageCardLayout: 'dividers' | 'fluid';
  tagsLayout: TagsLayoutVariant;
  savedFilters: SavedFilterDuty[];
  selectedSavedId: number | null;
  saveFilterName: string;
  reloadFreqsLoading: boolean;
  canRemove: boolean;
  maxWidth?: string | number;
  /** Current auth user display name for message watermarks */
  authUserName: string | null;
  copiedFeedbackId: string | null;
  networkDisplayMap: Record<number, string>;
  networkMap: Record<number, Network>;
  /** When true, empty network ids show "Не встановлена" only (no unit fallback). Server `featureStrictNetworks`. */
  featureStrictNetworks: boolean;
  tagsMap: Record<number, Tag>;
  tagIdsList: number[];
  onLoadOlder: () => void;
  onRemoveColumn: () => void;
  onApplyFilter: (f: RerDutyFeedFilterState) => void;
  onSelectAllGroups: () => void;
  onToggleGroup: (key: string) => void;
  onSendersChange: (v: string[]) => void;
  onDeniedSendersChange: (v: string[]) => void;
  onFreqsChange: (v: string[]) => void;
  onFreqsDeniedChange: (v: string[]) => void;
  onPostsChange: (v: string[]) => void;
  onPostsDeniedChange: (v: string[]) => void;
  onAdjacentFreqsRangeChange: (v: number) => void;
  onHighlightSignalsChange: (v: boolean) => void;
  onOnlyMyUnitTagsChange: (v: boolean) => void;
  onReloadFreqs: () => void;
  onSavedFilterSelect: (id: number | '') => void;
  onSaveFilterNameChange: (value: string) => void;
  onSaveFilter: () => void;
  onApplySavedFilter: (saved: SavedFilterDuty) => void;
  onDeleteSavedFilter: (id: number) => void;
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
  isWatchMode?: boolean;
  loadingNewer?: boolean;
  arrowResultMessage?: string | null;
  onArrowClick?: () => void;
  /** Called when the visible range changes; pass message IDs in view so parent can add them to readIds. When user reaches bottom, called with all IDs and atBottom: true so badge clears. */
  onVisibleMessageIds?: (ids: number[], opts?: { atBottom?: boolean }) => void;
  /** Unread count (items not in readIds); shown as badge when > 0. */
  unreadCount?: number;
  /** When true, message cards hide the left column (freq, date/time, buttons). Toggle is per feed. */
};

export type FeedColumnHandle = { scrollToEnd: () => void };

export const FeedColumn = forwardRef<FeedColumnHandle, FeedColumnProps>(function FeedColumn(
  {
    feed,
    feedCount,
    filterStable,
    groupsList,
    groupInfos,
    profiles,
    senderOptions,
    freqs,
    postsList,
    adjacentFreqsRange,
    highlightSignalsEnabled,
    onlyMyUnitTagsEnabled,
    messageCardLayout,
    tagsLayout,
    savedFilters,
    selectedSavedId,
    saveFilterName,
    reloadFreqsLoading,
    canRemove,
    authUserName,
    copiedFeedbackId,
    networkDisplayMap,
    networkMap,
    featureStrictNetworks,
    tagsMap,
    tagIdsList,
    onLoadOlder,
    onRemoveColumn,
    maxWidth,
    onApplyFilter,
    onSelectAllGroups,
    onToggleGroup,
    onSendersChange,
    onDeniedSendersChange,
    onFreqsChange,
    onFreqsDeniedChange,
    onPostsChange,
    onPostsDeniedChange,
    onAdjacentFreqsRangeChange,
    onHighlightSignalsChange,
    onOnlyMyUnitTagsChange,
    onReloadFreqs,
    onSavedFilterSelect,
    onSaveFilterNameChange,
    onSaveFilter,
    onApplySavedFilter,
    onDeleteSavedFilter,
    onMessageBookmark,
    onMessageImportant,
    onMessageCopy,
    onMessageComment,
    onMessageToggleTag,
    onScrollToTop,
    onReachedBottom,
    onLeftBottom,
    onNearBottomChange,
    isWatchMode = false,
    loadingNewer = false,
    arrowResultMessage = null,
    onArrowClick,
    onVisibleMessageIds,
    unreadCount = 0,
  },
  ref,
) {
  const feedId = feed.id;
  const [showFilters, setShowFilters] = useState(false);
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
      if (onVisibleMessageIds != null && len > 0) {
        const ids: number[] = [];
        for (let dataIndex = 0; dataIndex <= endDataIndex && dataIndex < len; dataIndex++) {
          ids.push(feed.items[dataIndex][0]);
        }
        if (ids.length > 0) onVisibleMessageIds(ids, { atBottom: false });
      }
    },
    [firstItemIndex, feed.items, feed.items.length, onNearBottomChange, onVisibleMessageIds, tryLoadOlder],
  );

  const applySenders = (v: string[]) => {
    onApplyFilter({ ...feed.filter, sendersSelected: v.length ? v : null });
  };
  const applyDeniedSenders = (v: string[]) => {
    onApplyFilter({ ...feed.filter, deniedSenders: v.length ? v : null });
  };
  const applyFreqs = (v: string[]) => {
    onApplyFilter({ ...feed.filter, freqsSelected: v.length ? v : null });
  };
  const applyFreqsDenied = (v: string[]) => {
    onApplyFilter({ ...feed.filter, freqsDenied: v.length ? v : null });
  };

  return (
    <Box
      className="flex flex-col flex-1 min-w-0 gap-1 min-h-0"
      sx={{ maxWidth: maxWidth ?? '100%', position: 'relative' }}
    >
      <Box
        className="flex justify-between gap-2 flex-wrap text-sm items-stretch h-[32px] shrink-0"
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          backgroundColor: 'background.paper',
          '& .MuiButton-root': {
            minHeight: 0,
            height: 32,
            maxHeight: 32,
            overflow: 'hidden',
          },
        }}
      >
        <div>
          <Button
            size="small"
            variant="text"
            className="self-stretch px-4"
            startIcon={<i className="bi bi-gear" />}
            endIcon={showFilters ? <i className="bi bi-chevron-up" /> : <i className="bi bi-chevron-down" />}
            onClick={() => setShowFilters((s) => !s)}
          >
            Фільтри
          </Button>
        </div>
        {canRemove && !showFilters && (
          <Button
            size="small"
            color="inherit"
            aria-label="Закрити колонку"
            onClick={onRemoveColumn}
            sx={{
              width: 48,
              minWidth: 48,
              '&:hover': { backgroundColor: '#1e2931', color: '#ccddfb' },
              transition: 'all 0.15s ease',
            }}
          >
            <i className="bi bi-x-lg" />
          </Button>
        )}
      </Box>
      {showFilters && (
        <FeedFilterPanel
          feedId={feedId}
          filterStable={filterStable}
          groupsList={groupsList}
          groupInfos={groupInfos}
          profiles={profiles}
          senderOptions={senderOptions}
          freqs={freqs}
          postsList={postsList}
          adjacentFreqsRange={adjacentFreqsRange}
          highlightSignalsEnabled={highlightSignalsEnabled}
          onlyMyUnitTagsEnabled={onlyMyUnitTagsEnabled}
          savedFilters={savedFilters}
          selectedSavedId={selectedSavedId}
          saveFilterName={saveFilterName}
          reloadFreqsLoading={reloadFreqsLoading}
          onSelectAllGroups={onSelectAllGroups}
          onToggleGroup={onToggleGroup}
          onSendersChange={applySenders}
          onDeniedSendersChange={applyDeniedSenders}
          onFreqsChange={applyFreqs}
          onFreqsDeniedChange={applyFreqsDenied}
          onPostsChange={onPostsChange}
          onPostsDeniedChange={onPostsDeniedChange}
          onAdjacentFreqsRangeChange={onAdjacentFreqsRangeChange}
          onHighlightSignalsChange={onHighlightSignalsChange}
          onOnlyMyUnitTagsChange={onOnlyMyUnitTagsChange}
          onReloadFreqs={onReloadFreqs}
          onSavedFilterSelect={onSavedFilterSelect}
          onSaveFilterNameChange={onSaveFilterNameChange}
          onSaveFilter={onSaveFilter}
          onApplySavedFilter={onApplySavedFilter}
          onDeleteSavedFilter={onDeleteSavedFilter}
        />
      )}

      {feed.loading ? (
        <Box className="flex-1 flex justify-center items-center min-h-0">
          <CircularProgress />
        </Box>
      ) : (
        <Paper variant="outlined" className="flex-1 overflow-hidden min-h-0 p-0 flex flex-col">
          <Virtuoso
            ref={virtuosoRef}
            style={{ flex: 1, minHeight: 400 }}
            data={feed.items}
            firstItemIndex={feed.firstItemIndex ?? 0}
            computeItemKey={(_index, [id]) => String(id)}
            initialTopMostItemIndex={Math.max(0, Math.floor(feed.items.length / 2) - 1)}
            startReached={tryLoadOlder}
            rangeChanged={handleRangeChanged}
            atTopStateChange={(atTop) => {
              if (atTop) {
                onScrollToTop?.();
                tryLoadOlder();
              }
            }}
            atBottomThreshold={300}
            atBottomStateChange={(atBottom) => {
              const wasAtBottom = atBottomRef.current;
              atBottomRef.current = atBottom;
              if (!atBottom) hasSeenNotAtBottomRef.current = true;
              setIsAtBottom(atBottom);
              if (atBottom && hasSeenNotAtBottomRef.current) onReachedBottom?.();
              if (!atBottom && wasAtBottom) onLeftBottom?.();
              if (atBottom && onVisibleMessageIds != null && feed.items.length > 0) {
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
            }}
            className="m-0 pl-3 pr-0 list-none rer-duty pt-2"
            itemContent={(_index, [id, msg]) => {
              const senderName = msg.sender != null ? profileLabel(msg.sender, profiles[msg.sender] ?? null) : null;
              const groupName = msg.groupMasterKey != null ? (groupInfos[msg.groupMasterKey]?.name ?? null) : null;
              const card = (
                <MessageCard
                  id={id}
                  msg={msg}
                  feedId={feedId}
                  feedCount={feedCount}
                  layoutVariant={messageCardLayout}
                  tagsLayout={tagsLayout}
                  referenceTimeMs={feed.referenceTimeMs}
                  authUserName={authUserName}
                  groupName={groupName}
                  senderName={senderName}
                  copiedFeedbackId={copiedFeedbackId}
                  networkDisplayMap={networkDisplayMap}
                  networkMap={networkMap}
                  featureStrictNetworks={featureStrictNetworks}
                  tagsMap={tagsMap}
                  onBookmark={() => onMessageBookmark(id, msg.bookmarked)}
                  onImportant={() => onMessageImportant(id, msg.important)}
                  onCopyText={() => onMessageCopy(msg.text || '', `text-${id}`)}
                  onCopyFreq={() => onMessageCopy(msg.freq ?? '', `freq-${id}`)}
                  onComment={() => onMessageComment(id, msg.extendedForm ?? null)}
                  onToggleTag={(tagId) => onMessageToggleTag(id, tagId)}
                  rightHeaderInsetPx={12}
                />
              );
              return card;
            }}
          />
          {onArrowClick != null && (!isAtBottom || loadingNewer || unreadCount > 0) && (
            <Box
              sx={{
                position: 'absolute',
                bottom: 30,
                right: 20,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                zIndex: 1,
              }}
            >
              {!loadingNewer && arrowResultMessage != null && (
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
                    width: 35,
                    height: 35,
                    minWidth: 35,
                    minHeight: 35,
                    position: 'relative',
                    backgroundColor: 'transparent',
                    zIndex: 0,
                    border: '2px solid',
                    borderColor: unreadCount > 0 ? 'primary.main' : 'grey.400',
                  }}
                  aria-label={isWatchMode ? 'Режим перегляду нових' : 'Завантажити нові та перейти вниз'}
                  onClick={onArrowClick}
                  disabled={loadingNewer}
                >
                  {loadingNewer ? (
                    <CircularProgress size={20} sx={{ color: 'primary.main' }} />
                  ) : (
                    <Box
                      component="i"
                      className="bi bi-arrow-down"
                      sx={{ fontSize: 20, color: unreadCount > 0 ? 'primary.main' : 'grey.400' }}
                    />
                  )}
                </Fab>
                {!loadingNewer && unreadCount > 0 && !isWatchMode && arrowResultMessage == null && (
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
