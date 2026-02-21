import { Box, Button, CircularProgress, Paper, Typography } from '@mui/material';
import React from 'react';

import type {
  InboxMessage,
  RerDutyFeedFilterState,
  SavedFilterDuty,
  SignalGroupEntry,
  SignalProfileEntry,
} from '../../../../Bindings';
import { profileLabel } from './utils';
import type { MessageFeedState } from './utils';
import { FeedFilterPanel } from './FeedFilterPanel';
import { MessageCard } from './MessageCard';

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
};

export function FeedColumn({
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
}: FeedColumnProps) {
  const feedId = feed.id;
  const [showFilters, setShowFilters] = React.useState(false);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const loadEarlierTriggeredRef = React.useRef(false);
  const initialScrollDoneRef = React.useRef(false);

  React.useEffect(() => {
    if (feed.loading || feed.items.length === 0 || initialScrollDoneRef.current) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const setScrollToMiddle = () => {
      const { scrollHeight, clientHeight } = el;
      if (scrollHeight > clientHeight) {
        el.scrollTop = (scrollHeight - clientHeight) / 2;
      }
      initialScrollDoneRef.current = true;
    };
    requestAnimationFrame(() => requestAnimationFrame(setScrollToMiddle));
  }, [feed.loading, feed.items.length]);

  const handleScroll = React.useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || feed.loadingEarlier || feed.hasReachedStart || feed.items.length === 0) return;
    const scrollTop = el.scrollTop;
    const threshold = 200;
    if (scrollTop <= threshold) {
      if (!loadEarlierTriggeredRef.current) {
        loadEarlierTriggeredRef.current = true;
        onLoadEarlier();
      }
    } else {
      loadEarlierTriggeredRef.current = false;
    }
  }, [feed.loadingEarlier, feed.hasReachedStart, feed.items.length, onLoadEarlier]);

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
    <Box className="flex flex-col flex-1 min-w-0 gap-1" sx={{ maxWidth: maxWidth ?? '100%', minWidth: 0 }}>
      <Box
        className="flex justify-between gap-2 flex-wrap text-sm items-stretch h-8"
        sx={{ '& .MuiButton-root': { minHeight: 0, height: '100%' } }}
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
            className="h-4 w-4"
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
        <Box className="flex-1 flex justify-center items-center min-h-[50vh] max-h-[90vh]">
          <CircularProgress />
        </Box>
      ) : (
        <Paper
          variant="outlined"
          className="flex-1 overflow-auto max-h-[90vh] min-h-0 p-0"
          ref={scrollContainerRef}
          onScroll={handleScroll}
        >
          {feed.items.length === 0 ? (
            <Typography color="text.secondary" className="p-4">
              Немає повідомлень
            </Typography>
          ) : (
            <Box component="ul" className="m-0 px-0 list-none rer-duty pt-2">
              {feed.items.map(([id, msg]) => {
                const senderName = msg.sender != null ? profileLabel(msg.sender, profiles[msg.sender] ?? null) : null;
                const groupName = msg.groupMasterKey != null ? (groupInfos[msg.groupMasterKey]?.name ?? null) : null;
                return (
                  <MessageCard
                    key={id}
                    id={id}
                    msg={msg}
                    feedId={feedId}
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
              })}
            </Box>
          )}
        </Paper>
      )}
    </Box>
  );
}
