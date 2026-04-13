import { Box, Button, Paper } from '@mui/material';
import { useEffect, useMemo, useState } from 'react';

import { CommentDialog, DeleteConfirmDialog } from './dialogs';
import { setDutyNeoDocumentTitleUnreadCount, startDutyNeoDocumentTitleTracking } from './notifications';
import { FeedColumn } from './FeedColumn';
import { feedColumnUnreadDisplayed, DEFAULT_DUTY_TAGS_LAYOUT, type TagsLayoutVariant } from './utils';
import { MAX_MESSAGE_FEEDS, useRerDutyFeeds } from './useRerDutyFeeds';
import { fetchUserSettings } from '../../services/api/user-settings';

export type RerDutyNeoPageProps = {
  /** Auth user display name from the host page (avoids duplicate /api/user request). */
  authUserName?: string | null;
};

export function RerDutyNeoPage({ authUserName: authUserNameProp = null }: RerDutyNeoPageProps = {}) {
  const authUserName = authUserNameProp ?? null;
  const [tagsLayout, setTagsLayout] = useState<TagsLayoutVariant>(DEFAULT_DUTY_TAGS_LAYOUT);
  useEffect(() => {
    let cancelled = false;
    const loadLayout = async () => {
      try {
        const prefs = await fetchUserSettings();
        if (cancelled) return;
        setTagsLayout(prefs.tagsLayout);
      } catch {
        if (cancelled) return;
        setTagsLayout(DEFAULT_DUTY_TAGS_LAYOUT);
      }
    };
    loadLayout();
    return () => {
      cancelled = true;
    };
  }, []);
  const {
    messageFeeds,
    error,
    columnRefsRef,
    nearBottomByFeedIdRef,
    atBottomByFeedIdRef,
    dutyDisableAutoScroll,
    createMessageFeed,
    removeMessageFeed,
    loadFeedInitialMessages,
    loadFeedOlderMessages,
    applyFilter,
    toggleGroup,
    selectAllGroups,
    handleSaveFilter,
    handleApplySavedFilter,
    handleDeleteSavedFilter,
    handleMessageBookmark,
    handleMessageImportant,
    handleMessageCopy,
    handleDeleteConfirm,
    setDeleteConfirmId,
    setDeleteConfirmFeedId,
    openCommentDialog,
    handleCommentSave,
    handleToggleTag,
    handleArrowClick,
    handleVisibleMessageIds,
    commentMessageId,
    commentText,
    setCommentText,
    setCommentMessageId,
    setCommentFeedId,
    deleteConfirmId,
    deleteConfirmFeedId,
    profiles,
    senderOptions,
    freqs,
    postsList,
    groupsList,
    groupInfos,
    tagsMap,
    tagIdsList,
    savedFilters,
    selectedSavedId,
    setSelectedSavedId,
    saveFilterName,
    setSaveFilterName,
    reloadFreqsLoading,
    reloadLatestFrequencies,
    networkDisplayMap,
    networkMap,
    unitsMap,
    callsignInfoMap,
    featureStrictNetworks,
    watchModeByFeedId,
    setWatchModeByFeedId,
    loadingNewerFeedId,
    arrowResultByFeedId,
    copiedFeedbackId,
    setMessageFeeds,
  } = useRerDutyFeeds(authUserName);

  const dutyTabUnreadTotal = useMemo(
    () => messageFeeds.reduce((sum, w) => sum + feedColumnUnreadDisplayed(w), 0),
    [messageFeeds],
  );

  useEffect(() => startDutyNeoDocumentTitleTracking(), []);
  useEffect(() => {
    setDutyNeoDocumentTitleUnreadCount(dutyTabUnreadTotal);
  }, [dutyTabUnreadTotal]);

  return (
    <Box className="flex flex-col w-full" sx={{ height: 'calc(100vh - 54px)', minHeight: 0, overflow: 'hidden' }}>
      <Box className="flex items-center justify-between flex-wrap gap-2 mb-2 shrink-0" />

      {error && (
        <Paper elevation={0} className="p-2 mb-2 shrink-0" sx={{ bgcolor: 'error.light', color: 'error.contrastText' }}>
          {error}
        </Paper>
      )}

      <Box className="flex flex-1 flex-nowrap gap-2 overflow-x-auto justify-center w-full min-h-0">
        {messageFeeds.map((w) => {
          const filterStable = {
            groupsSelected: w.filter.groupsSelected ?? [],
            sendersSelected: w.filter.sendersSelected ?? [],
            deniedSenders: w.filter.deniedSenders ?? [],
            freqsSelected: w.filter.freqsSelected ?? [],
            freqsDenied: w.filter.freqsDenied ?? [],
            postsSelected: w.filter.postsSelected ?? [],
            postsDenied: w.filter.postsDenied ?? [],
          };
          return (
            <FeedColumn
              key={w.id}
              ref={(el) => {
                columnRefsRef.current[w.id] = el;
              }}
              feed={w}
              feedCount={messageFeeds.length}
              unreadCount={feedColumnUnreadDisplayed(w)}
              filterStable={filterStable}
              groupsList={groupsList}
              groupInfos={groupInfos}
              profiles={profiles}
              senderOptions={senderOptions}
              freqs={freqs}
              postsList={postsList}
              adjacentFreqsRange={w.adjacentFreqsRange}
              highlightSignalsEnabled={w.highlightSignalsEnabled}
              onlyMyUnitTagsEnabled={w.onlyMyUnitTagsEnabled}
              tagsLayout={tagsLayout}
              savedFilters={savedFilters}
              selectedSavedId={selectedSavedId}
              saveFilterName={saveFilterName}
              reloadFreqsLoading={reloadFreqsLoading}
              canRemove={messageFeeds.length > 1}
              maxWidth={
                messageFeeds.length >= 4
                  ? 'calc((100% - 2rem) / 4)'
                  : messageFeeds.length === 3
                    ? 'calc((100% - 2rem) / 3)'
                    : messageFeeds.length === 2
                      ? 'calc((90% - 2rem) / 2)'
                      : '45%'
              }
              authUserName={authUserName}
              copiedFeedbackId={copiedFeedbackId}
              networkDisplayMap={networkDisplayMap}
              networkMap={networkMap}
              unitsMap={unitsMap}
              callsignInfoMap={callsignInfoMap}
              featureStrictNetworks={featureStrictNetworks}
              tagsMap={tagsMap}
              tagIdsList={tagIdsList}
              onLoadOlder={() => loadFeedOlderMessages(w.id)}
              onRemoveColumn={() => removeMessageFeed(w.id)}
              onApplyFilter={(f) => applyFilter(w.id, f)}
              onSelectAllGroups={() => selectAllGroups(w.id)}
              onToggleGroup={(key) => toggleGroup(w.id, key)}
              onSendersChange={(v) => applyFilter(w.id, { ...w.filter, sendersSelected: v.length ? v : null })}
              onDeniedSendersChange={(v) => applyFilter(w.id, { ...w.filter, deniedSenders: v.length ? v : null })}
              onFreqsChange={(v) => applyFilter(w.id, { ...w.filter, freqsSelected: v.length ? v : null })}
              onFreqsDeniedChange={(v) => applyFilter(w.id, { ...w.filter, freqsDenied: v.length ? v : null })}
              onPostsChange={(v) => applyFilter(w.id, { ...w.filter, postsSelected: v.length ? v : null })}
              onPostsDeniedChange={(v) => applyFilter(w.id, { ...w.filter, postsDenied: v.length ? v : null })}
              onAdjacentFreqsRangeChange={(v) =>
                setMessageFeeds((prev) => prev.map((f) => (f.id === w.id ? { ...f, adjacentFreqsRange: v } : f)))
              }
              onHighlightSignalsChange={(v) => {
                setMessageFeeds((prev) => prev.map((f) => (f.id === w.id ? { ...f, highlightSignalsEnabled: v } : f)));
                loadFeedInitialMessages(w.id, { highlightSignalsEnabled: v });
              }}
              onOnlyMyUnitTagsChange={(v) => {
                setMessageFeeds((prev) => prev.map((f) => (f.id === w.id ? { ...f, onlyMyUnitTagsEnabled: v } : f)));
                loadFeedInitialMessages(w.id, { onlyMyUnitTagsEnabled: v });
              }}
              onReloadFreqs={reloadLatestFrequencies}
              onSavedFilterSelect={(id) => setSelectedSavedId(id === '' ? null : id)}
              onSaveFilterNameChange={setSaveFilterName}
              onSaveFilter={() => handleSaveFilter(w.id)}
              onApplySavedFilter={(saved) => handleApplySavedFilter(w.id, saved)}
              onDeleteSavedFilter={handleDeleteSavedFilter}
              onMessageBookmark={(msgId, currentlyBookmarked) =>
                handleMessageBookmark(w.id, msgId, currentlyBookmarked)
              }
              onMessageImportant={(msgId, currentlyImportant) =>
                handleMessageImportant(w.id, msgId, currentlyImportant)
              }
              onMessageCopy={handleMessageCopy}
              onMessageComment={(msgId, currentComment) => openCommentDialog(msgId, w.id, currentComment)}
              onMessageToggleTag={(msgId, tagId) => handleToggleTag(w.id, msgId, tagId)}
              onScrollToTop={() => setWatchModeByFeedId((prev) => ({ ...prev, [w.id]: false }))}
              onReachedBottom={() => {
                if (!dutyDisableAutoScroll) {
                  setWatchModeByFeedId((prev) => ({ ...prev, [w.id]: true }));
                }
                if (w.items.length > 0) {
                  handleVisibleMessageIds(w.id)(
                    w.items.map(([id]) => id),
                    { atBottom: true },
                  );
                }
              }}
              onLeftBottom={() => setWatchModeByFeedId((prev) => ({ ...prev, [w.id]: false }))}
              onNearBottomChange={(near) => {
                nearBottomByFeedIdRef.current = {
                  ...nearBottomByFeedIdRef.current,
                  [w.id]: near,
                };
              }}
              onAtBottomChange={(atBottom) => {
                atBottomByFeedIdRef.current = {
                  ...atBottomByFeedIdRef.current,
                  [w.id]: atBottom,
                };
              }}
              isWatchMode={!dutyDisableAutoScroll && (watchModeByFeedId[w.id] ?? false)}
              loadingNewer={loadingNewerFeedId === w.id}
              arrowResultMessage={arrowResultByFeedId[w.id] ?? null}
              onArrowClick={() => handleArrowClick(w.id)}
              onVisibleMessageIds={handleVisibleMessageIds(w.id)}
            />
          );
        })}
        {messageFeeds.length < MAX_MESSAGE_FEEDS && (
          <Button
            size="large"
            variant="text"
            className="p-0 self-start shrink-0"
            sx={{
              width: 48,
              minWidth: 48,
              height: 32,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              backgroundColor: 'transparent',
              '&:hover': { backgroundColor: 'background.default' },
              '& .bi': { fontSize: 23 },
            }}
            onClick={createMessageFeed}
            aria-label="Додати колонку"
          >
            <i className="bi bi-plus-square" />
          </Button>
        )}
      </Box>

      <CommentDialog
        open={commentMessageId != null}
        commentText={commentText}
        onCommentTextChange={setCommentText}
        onClose={() => {
          setCommentMessageId(null);
          setCommentFeedId(null);
        }}
        onSave={handleCommentSave}
      />

      <DeleteConfirmDialog
        open={deleteConfirmId != null}
        onClose={() => {
          setDeleteConfirmId(null);
          setDeleteConfirmFeedId(null);
        }}
        onConfirm={handleDeleteConfirm}
      />
    </Box>
  );
}
