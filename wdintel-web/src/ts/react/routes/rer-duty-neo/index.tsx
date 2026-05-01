import { Box, ButtonBase, Fab, Paper, useMediaQuery, useTheme } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useEffect, useMemo, useRef, useState } from 'react';

import { CommentDialog, DeleteConfirmDialog } from './dialogs';
import { setDutyNeoDocumentTitleUnreadCount, startDutyNeoDocumentTitleTracking } from './notifications';
import { FeedColumn } from './FeedColumn';
import {
  DEFAULT_DUTY_TAGS_LAYOUT,
  feedUnreadDisplayCount,
  feedsUnreadDisplayTotal,
  type TagsLayoutVariant,
} from './utils';
import { MAX_MESSAGE_FEEDS, useRerDutyFeeds } from './useRerDutyFeeds';
import { USER_SETTINGS_UPDATED_EVENT, fetchUserSettings } from '../../services/api/user-settings';
import { dutyTopAddFabSx } from './top-action-styles';

export type RerDutyNeoPageProps = {
  /** Auth user display name from the host page (avoids duplicate /api/user request). */
  authUserName?: string | null;
};

function dutyFeedColumnMaxWidth(feedCount: number, narrow: boolean): string {
  if (narrow) return '100%';
  if (feedCount <= 1) return '960px';
  return '100%';
}

/** Below `sm`: scales subtree ~12.5%; height is divided so the zoomed box still fits the viewport. */
const DUTY_MOBILE_ROOT_ZOOM = 1.125;
const DUTY_VIEWPORT_HEIGHT = 'calc(100vh - var(--app-shell-total-offset, 0px))';
const DUTY_VIEWPORT_HEIGHT_DVH = 'calc(100dvh - var(--app-shell-total-offset, 0px))';

export function RerDutyNeoPage({ authUserName: authUserNameProp = null }: RerDutyNeoPageProps = {}) {
  const theme = useTheme();
  const narrowScreen = useMediaQuery(theme.breakpoints.down(1024));
  const authUserName = authUserNameProp ?? null;
  const [activeFeedId, setActiveFeedId] = useState<string | null>(null);
  const previousFeedCountRef = useRef(0);
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
  useEffect(() => {
    const onSettingsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ tagsLayout?: TagsLayoutVariant }>).detail;
      if (!detail?.tagsLayout) return;
      setTagsLayout(detail.tagsLayout);
    };

    window.addEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
    return () => {
      window.removeEventListener(USER_SETTINGS_UPDATED_EVENT, onSettingsUpdated as EventListener);
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
    handleSaveFilter,
    handleApplySavedFilter,
    handleUpdateSelectedSavedFilter,
    handleRenameSelectedSavedFilter,
    handleDeleteSelectedSavedFilter,
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
  const activeFeedIdSafe =
    messageFeeds.some((feed) => feed.id === activeFeedId) ? activeFeedId : messageFeeds[0]?.id ?? null;

  useEffect(() => {
    if (messageFeeds.length === 0) {
      setActiveFeedId(null);
      previousFeedCountRef.current = 0;
      return;
    }
    setActiveFeedId((current) => {
      const currentExists = current != null && messageFeeds.some((feed) => feed.id === current);
      if (messageFeeds.length > previousFeedCountRef.current) {
        return messageFeeds[messageFeeds.length - 1].id;
      }
      if (currentExists) return current;
      return messageFeeds[0].id;
    });
    previousFeedCountRef.current = messageFeeds.length;
  }, [messageFeeds]);

  const dutyTabUnreadTotal = useMemo(() => feedsUnreadDisplayTotal(messageFeeds), [messageFeeds]);
  const showAddButton = messageFeeds.length < MAX_MESSAGE_FEEDS;
  const activeFeedIndex = activeFeedIdSafe == null ? -1 : messageFeeds.findIndex((feed) => feed.id === activeFeedIdSafe);

  useEffect(() => startDutyNeoDocumentTitleTracking(), []);
  useEffect(() => {
    setDutyNeoDocumentTitleUnreadCount(dutyTabUnreadTotal);
  }, [dutyTabUnreadTotal]);

  return (
    <Box
      className="flex flex-col w-full min-h-0"
      sx={{
        zoom: narrowScreen ? DUTY_MOBILE_ROOT_ZOOM : 1,
        height: narrowScreen
          ? `calc((${DUTY_VIEWPORT_HEIGHT}) / ${DUTY_MOBILE_ROOT_ZOOM})`
          : DUTY_VIEWPORT_HEIGHT,
        '@supports (height: 100dvh)': {
          height: narrowScreen
            ? `calc((${DUTY_VIEWPORT_HEIGHT_DVH}) / ${DUTY_MOBILE_ROOT_ZOOM})`
            : DUTY_VIEWPORT_HEIGHT_DVH,
        },
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <Box className="flex items-center justify-between flex-wrap gap-2 mb-2 shrink-0" />

      {error && (
        <Paper elevation={0} className="p-2 mb-2 shrink-0" sx={{ bgcolor: 'error.light', color: 'error.contrastText' }}>
          {error}
        </Paper>
      )}

      <Box className="flex flex-1 min-h-0 w-full overflow-hidden">
        <Box
          className="h-full min-h-0 w-full overflow-hidden flex gap-2"
          sx={{
            pr: showAddButton ? 6 : 0,
            position: 'relative',
          }}
        >
          <Box className="flex flex-1 min-w-0 min-h-0 flex-col gap-2">
            {narrowScreen && messageFeeds.length > 1 && activeFeedIdSafe != null && (
              <Box
                role="tablist"
                aria-label="Потоки"
                sx={{
                  flexShrink: 0,
                  position: 'relative',
                  height: 48,
                  backgroundColor: 'background.paper',
                  borderRadius: 1,
                  overflow: 'hidden',
                }}
              >
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${messageFeeds.length}, minmax(0, 1fr))`,
                    height: '100%',
                  }}
                >
                  {messageFeeds.map((feed, index) => {
                    const selected = feed.id === activeFeedIdSafe;
                    return (
                      <ButtonBase
                        key={feed.id}
                        role="tab"
                        aria-selected={selected}
                        onClick={() => setActiveFeedId(feed.id)}
                        sx={{
                          minWidth: 0,
                          minHeight: 0,
                          height: '100%',
                          px: 1,
                          color: selected ? 'primary.main' : 'text.primary',
                          fontWeight: 500,
                          fontSize: '0.875rem',
                          lineHeight: 1.43,
                          letterSpacing: '0.01071em',
                          textTransform: 'uppercase',
                          opacity: selected ? 1 : 0.72,
                          transition: 'color 0.15s ease',
                          '&:hover': {
                            backgroundColor: 'action.hover',
                            opacity: 1,
                          },
                        }}
                      >
                        Стрічка {index + 1}
                      </ButtonBase>
                    );
                  })}
                </Box>
                {activeFeedIndex >= 0 && (
                  <Box
                    aria-hidden
                    sx={{
                      position: 'absolute',
                      left: `calc(${activeFeedIndex} * (100% / ${messageFeeds.length}))`,
                      bottom: 0,
                      width: `calc(100% / ${messageFeeds.length})`,
                      height: 4,
                      borderRadius: 999,
                      backgroundColor: 'primary.main',
                      transition: 'left 0.2s ease, width 0.2s ease',
                    }}
                  />
                )}
              </Box>
            )}
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
              {narrowScreen ? (
                messageFeeds.map((w) => {
                  const filterStable = {
                    groupsSelected: w.filter.groupsSelected ?? [],
                    deniedGroups: w.filter.groupsDenied ?? [],
                    sendersSelected: w.filter.sendersSelected ?? [],
                    deniedSenders: w.filter.deniedSenders ?? [],
                    freqsSelected: w.filter.freqsSelected ?? [],
                    freqsDenied: w.filter.freqsDenied ?? [],
                    postsSelected: w.filter.postsSelected ?? [],
                    postsDenied: w.filter.postsDenied ?? [],
                  };
                  const isActive = w.id === activeFeedIdSafe;
                  return (
                    <Box
                      key={w.id}
                      sx={{
                        position: 'absolute',
                        inset: 0,
                        display: isActive ? 'flex' : 'none',
                        minHeight: 0,
                        minWidth: 0,
                      }}
                    >
                      <FeedColumn
                        ref={(el) => {
                          columnRefsRef.current[w.id] = el;
                        }}
                        narrowScreen={narrowScreen}
                        feed={w}
                        feedCount={messageFeeds.length}
                        unreadCount={feedUnreadDisplayCount(w)}
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
                        maxWidth={dutyFeedColumnMaxWidth(messageFeeds.length, narrowScreen)}
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
                        onGroupsChange={(v) => applyFilter(w.id, { ...w.filter, groupsSelected: v.length ? v : null })}
                        onDeniedGroupsChange={(v) => applyFilter(w.id, { ...w.filter, groupsDenied: v.length ? v : null })}
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
                          setMessageFeeds((prev) =>
                            prev.map((f) => (f.id === w.id ? { ...f, highlightSignalsEnabled: v } : f)),
                          );
                          loadFeedInitialMessages(w.id, { highlightSignalsEnabled: v });
                        }}
                        onOnlyMyUnitTagsChange={(v) => {
                          setMessageFeeds((prev) =>
                            prev.map((f) => (f.id === w.id ? { ...f, onlyMyUnitTagsEnabled: v } : f)),
                          );
                          loadFeedInitialMessages(w.id, { onlyMyUnitTagsEnabled: v });
                        }}
                        onReloadFreqs={reloadLatestFrequencies}
                        onSavedFilterSelect={(id) => setSelectedSavedId(id === '' ? null : id)}
                        onSaveFilterNameChange={setSaveFilterName}
                        onSaveFilter={handleSaveFilter}
                        onUpdateSelectedSavedFilter={handleUpdateSelectedSavedFilter}
                        onRenameSelectedSavedFilter={handleRenameSelectedSavedFilter}
                        onDeleteSelectedSavedFilter={handleDeleteSelectedSavedFilter}
                        onApplySavedFilter={(saved) => handleApplySavedFilter(w.id, saved)}
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
                    </Box>
                  );
                })
              ) : (
                <Box
                  className="h-full min-h-0 w-full overflow-hidden"
                  sx={{
                    display: messageFeeds.length <= 1 ? 'flex' : 'grid',
                    alignItems: 'start',
                    justifyContent: messageFeeds.length <= 1 ? 'center' : 'stretch',
                    gap: messageFeeds.length <= 1 ? 1 : 2,
                    gridTemplateColumns:
                      messageFeeds.length <= 1 ? undefined : `repeat(${messageFeeds.length}, minmax(0, 1fr))`,
                  }}
                >
                  {messageFeeds.map((w) => {
                    const filterStable = {
                      groupsSelected: w.filter.groupsSelected ?? [],
                      deniedGroups: w.filter.groupsDenied ?? [],
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
                        narrowScreen={narrowScreen}
                        feed={w}
                        feedCount={messageFeeds.length}
                        unreadCount={feedUnreadDisplayCount(w)}
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
                        maxWidth={dutyFeedColumnMaxWidth(messageFeeds.length, narrowScreen)}
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
                        onGroupsChange={(v) => applyFilter(w.id, { ...w.filter, groupsSelected: v.length ? v : null })}
                        onDeniedGroupsChange={(v) => applyFilter(w.id, { ...w.filter, groupsDenied: v.length ? v : null })}
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
                          setMessageFeeds((prev) =>
                            prev.map((f) => (f.id === w.id ? { ...f, highlightSignalsEnabled: v } : f)),
                          );
                          loadFeedInitialMessages(w.id, { highlightSignalsEnabled: v });
                        }}
                        onOnlyMyUnitTagsChange={(v) => {
                          setMessageFeeds((prev) =>
                            prev.map((f) => (f.id === w.id ? { ...f, onlyMyUnitTagsEnabled: v } : f)),
                          );
                          loadFeedInitialMessages(w.id, { onlyMyUnitTagsEnabled: v });
                        }}
                        onReloadFreqs={reloadLatestFrequencies}
                        onSavedFilterSelect={(id) => setSelectedSavedId(id === '' ? null : id)}
                        onSaveFilterNameChange={setSaveFilterName}
                        onSaveFilter={handleSaveFilter}
                        onUpdateSelectedSavedFilter={handleUpdateSelectedSavedFilter}
                        onRenameSelectedSavedFilter={handleRenameSelectedSavedFilter}
                        onDeleteSelectedSavedFilter={handleDeleteSelectedSavedFilter}
                        onApplySavedFilter={(saved) => handleApplySavedFilter(w.id, saved)}
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
                </Box>
              )}
            </Box>
          </Box>
          {showAddButton && (
            <Box
              sx={{
                position: 'absolute',
                right: 0,
                bottom: { xs: 'max(12px, env(safe-area-inset-bottom, 0px))', sm: 12 },
                width: 44,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'flex-end',
                pointerEvents: 'none',
              }}
            >
              <Fab
                color="primary"
                aria-label="Додати колонку"
                onClick={createMessageFeed}
                sx={{ ...dutyTopAddFabSx, pointerEvents: 'auto' }}
              >
                <AddIcon />
              </Fab>
            </Box>
          )}
        </Box>
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
