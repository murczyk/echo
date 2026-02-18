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
  showFilters: boolean;
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
  showFilters,
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
    <Box className="flex flex-col flex-1 min-w-[320px] gap-2" sx={{ maxWidth: maxWidth ?? '100%' }}>
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

      <Box className="mb-2 flex items-center justify-between">
        <Button
          size="small"
          variant="outlined"
          disabled={feed.loadingEarlier || feed.items.length === 0}
          onClick={onLoadEarlier}
          title="Завантажити старіші"
        >
          {feed.loadingEarlier ? <CircularProgress size={16} /> : 'Завантажити старіші'}
        </Button>
        <Typography variant="caption" className="ml-2" component="span" title="Кількість повідомлень у цій колонці">
          Показано: {feed.items.length}
        </Typography>
        <Box className="gap-1">
          {canRemove && (
            <Button
              size="small"
              color="error"
              aria-label="Закрити колонку"
              onClick={onRemoveColumn}
              className="min-w-8"
            >
              <i className="bi bi-x-lg" />
            </Button>
          )}
        </Box>
      </Box>

      {feed.loading ? (
        <Box className="flex justify-center items-center py-8">
          <CircularProgress />
        </Box>
      ) : (
        <Paper variant="outlined" className="flex-1 overflow-auto max-h-[65vh] p-0">
          {feed.items.length === 0 ? (
            <Typography color="text.secondary" className="p-4">
              Немає повідомлень
            </Typography>
          ) : (
            <Box component="ul" className="m-0 px-0 list-none rer-duty pt-2">
              {feed.items.map(([id, msg]) => {
                const senderName = msg.sender != null ? profileLabel(msg.sender, profiles[msg.sender] ?? null) : null;
                const groupName = msg.groupMasterKey != null ? groupInfos[msg.groupMasterKey]?.name ?? null : null;
                return (
                  <MessageCard
                    key={id}
                    id={id}
                    msg={msg}
                    feedId={feedId}
                    groupName={groupName}
                    senderName={senderName}
                    copiedFeedbackId={copiedFeedbackId}
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
