import { Box, Button, CircularProgress, Fab, Paper, Typography } from '@mui/material';
import React from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import type {
  InboxMessage,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SavedFilterDuty,
  SignalGroupEntry,
  SignalProfileEntry,
} from '../../../../Bindings';
import { profileLabel } from './utils';
import type { MessageFeedState } from './utils';
import { FeedFilterPanel } from './FeedFilterPanel';
import { MessageCard } from './MessageCard';
import { PowerChip } from '../../components/PowerChip';

/** When the first visible item is within this many items of the top, trigger load earlier (so user doesn't hit top and wait). */
const LOAD_EARLIER_BUFFER_ITEMS = 6;

const FeedScroller = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(function FeedScroller(
  { style, className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-virtuoso-scroller
      style={style}
      className={[className, 'rer-duty-feed-scroll'].filter(Boolean).join(' ')}
      {...props}
    />
  );
});

export type FeedColumnProps = {
  feed: MessageFeedState;
  filterStable: {
    groupsSelected: string[];
    sendersSelected: string[];
    deniedSenders: string[];
    freqsSelected: string[];
    freqsDenied: string[];
  };
  groupsList: string[];
  groupInfos: Record<string, SignalGroupEntry>;
  profiles: Record<string, SignalProfileEntry | null>;
  senderOptions: Array<{ id: string; label: string }>;
  freqs: string[];
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
  tagsMap: Record<number, string>;
  tagIdsList: number[];
  messageHasTag: (msg: InboxMessage, tagId: number) => boolean;
  onLoadEarlier: () => void;
  onRemoveColumn: () => void;
  onApplyFilter: (f: RerDutyFeedFilterState) => void;
  onSelectAllGroups: () => void;
  onToggleGroup: (key: string) => void;
  onSendersChange: (v: string[]) => void;
  onDeniedSendersChange: (v: string[]) => void;
  onFreqsChange: (v: string[]) => void;
  onFreqsDeniedChange: (v: string[]) => void;
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
  isWatchMode?: boolean;
  digestCount?: number | null;
  loadingNewer?: boolean;
  arrowResultMessage?: string | null;
  onArrowClick?: () => void;
};

export type FeedColumnHandle = { scrollToEnd: () => void };

export const FeedColumn = React.forwardRef<FeedColumnHandle, FeedColumnProps>(function FeedColumn(
  {
    feed,
    filterStable,
    groupsList,
    groupInfos,
    profiles,
    senderOptions,
    freqs,
    savedFilters,
    selectedSavedId,
    saveFilterName,
    reloadFreqsLoading,
    canRemove,
    authUserName,
    copiedFeedbackId,
    networkDisplayMap,
    tagsMap,
    tagIdsList,
    messageHasTag,
    onLoadEarlier,
    onRemoveColumn,
    maxWidth,
    onApplyFilter,
    onSelectAllGroups,
    onToggleGroup,
    onSendersChange,
    onDeniedSendersChange,
    onFreqsChange,
    onFreqsDeniedChange,
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
    isWatchMode = false,
    digestCount = null,
    loadingNewer = false,
    arrowResultMessage = null,
    onArrowClick,
  },
  ref,
) {
  const feedId = feed.id;
  const [showFilters, setShowFilters] = React.useState(false);
  const [isAtBottom, setIsAtBottom] = React.useState(true);
  const loadEarlierTriggeredRef = React.useRef(false);
  const virtuosoRef = React.useRef<VirtuosoHandle | null>(null);
  /** Only enable watch mode when user has scrolled to bottom, not when we're at bottom on initial render. */
  const hasSeenNotAtBottomRef = React.useRef(false);
  /** Last at-bottom value from Virtuoso; use for transition detection so we don't rely on stale state. */
  const atBottomRef = React.useRef(true);

  React.useEffect(() => {
    if (!feed.loadingEarlier) loadEarlierTriggeredRef.current = false;
  }, [feed.loadingEarlier]);

  React.useImperativeHandle(
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

  const tryLoadEarlier = React.useCallback(() => {
    if (loadEarlierTriggeredRef.current || feed.loadingEarlier || feed.hasReachedStart) return;
    loadEarlierTriggeredRef.current = true;
    onLoadEarlier();
  }, [feed.loadingEarlier, feed.hasReachedStart, onLoadEarlier]);

  const handleRangeChanged = React.useCallback(
    (range: { startIndex: number }) => {
      if (range.startIndex <= LOAD_EARLIER_BUFFER_ITEMS) {
        tryLoadEarlier();
      } else if (range.startIndex > LOAD_EARLIER_BUFFER_ITEMS * 2) {
        loadEarlierTriggeredRef.current = false;
      }
    },
    [tryLoadEarlier],
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

  const hasNewMessages = (digestCount ?? 0) > 0;

  return (
    <Box
      className="flex flex-col flex-1 min-w-0 gap-1 min-h-0"
      sx={{ maxWidth: maxWidth ?? '100%', minWidth: 0, minHeight: 0, position: 'relative' }}
    >
      <Box
        className="flex justify-between gap-2 flex-wrap text-sm items-stretch h-8 shrink-0"
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          backgroundColor: 'background.paper',
          '& .MuiButton-root': { minHeight: 0, height: '100%' },
        }}
      >
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
            startReached={tryLoadEarlier}
            rangeChanged={handleRangeChanged}
            atTopStateChange={(atTop) => {
              if (atTop) {
                onScrollToTop?.();
                tryLoadEarlier();
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
            }}
            components={{
              Scroller: FeedScroller,
              Header: () =>
                feed.loadingEarlier ? (
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
                ) : feed.hasReachedStart || digestCount === 0 ? (
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
            className="m-0 px-0 list-none rer-duty pt-2"
            itemContent={(_index, [id, msg]) => {
              const senderName = msg.sender != null ? profileLabel(msg.sender, profiles[msg.sender] ?? null) : null;
              const groupName = msg.groupMasterKey != null ? (groupInfos[msg.groupMasterKey]?.name ?? null) : null;
              return (
                <MessageCard
                  id={id}
                  msg={msg}
                  feedId={feedId}
                  referenceTimeMs={feed.referenceTimeMs}
                  authUserName={authUserName}
                  groupName={groupName}
                  senderName={senderName}
                  copiedFeedbackId={copiedFeedbackId}
                  networkDisplayMap={networkDisplayMap}
                  tagsMap={tagsMap}
                  tagIdsList={tagIdsList}
                  messageHasTag={messageHasTag}
                  onBookmark={() => onMessageBookmark(id, msg.bookmarked)}
                  onImportant={() => onMessageImportant(id, msg.important)}
                  onCopyText={() => onMessageCopy(msg.text || '', `text-${id}`)}
                  onCopyFreq={() => onMessageCopy(msg.freq ?? '', `freq-${id}`)}
                  onComment={() => onMessageComment(id, msg.extendedForm ?? null)}
                  onToggleTag={(tagId) => onMessageToggleTag(id, tagId)}
                />
              );
            }}
          />
          {onArrowClick != null && (!isAtBottom || loadingNewer) && (
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
                  color={(digestCount ?? 0) > 0 ? 'primary' : 'default'}
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
                    borderColor: (digestCount ?? 0) > 0 ? 'primary.main' : 'grey.400',
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
                      sx={{
                        fontSize: 20,
                        color: (digestCount ?? 0) > 0 ? 'primary.main' : 'grey.400',
                      }}
                    />
                  )}
                </Fab>
                {!loadingNewer &&
                  digestCount != null &&
                  digestCount > 0 &&
                  !isWatchMode &&
                  arrowResultMessage == null && (
                    <PowerChip
                      size="small"
                      label={digestCount}
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
