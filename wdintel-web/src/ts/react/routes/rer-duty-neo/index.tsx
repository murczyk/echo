import { Box, useMediaQuery, useTheme } from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isPresent } from '../../utils/misc';

import { DeleteConfirmDialog } from './dialogs';
import {
  setDutyNeoDocumentTitleUnreadCount,
  startDutyNeoDocumentTitleTracking,
} from './notifications';
import { feedIndicatorUnreadCount } from './utils';
import { useRerDutyFeeds } from './useRerDutyFeeds';
import { useRerDutyPageSettings } from './useRerDutyPageSettings';
import { useDutyFeedColumnModel } from './useDutyFeedColumnModel';
import { PowerAlert } from '../../components/PowerAlert';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { RerDutyNeoWorkspace } from './RerDutyNeoWorkspace';
import type { InboxMessage } from '../../../../Bindings';
import { ManageMessageDrawer } from '../shared/manage-message/ManageMessageDrawer';
import { AudioTranscriptionPreferencesProvider } from '../shared/message-card/MessageCardAudioTranscription';
import { fetchMessagesByIds } from '../../services/api/inbox-messages';
import { PointBlacklistPaletteNamesCacheProvider } from '../shared/message-card/PointBlacklistPaletteNamesCache';

export type RerDutyNeoPageProps = {
  /** Auth user display name from the host page (avoids duplicate /api/user request). */
  authUserName?: string | null;
};

/** Below `sm`: scales subtree ~12.5%; height is divided so the zoomed box still fits the viewport. */
const DUTY_MOBILE_ROOT_ZOOM = 1.125;
const DUTY_VIEWPORT_HEIGHT = 'calc(100vh - var(--app-shell-total-offset, 0px))';
const DUTY_VIEWPORT_HEIGHT_DVH = 'calc(100dvh - var(--app-shell-total-offset, 0px))';

export function RerDutyNeoPage({
  authUserName: authUserNameProp = null,
}: RerDutyNeoPageProps = {}) {
  const theme = useTheme();
  const narrowScreen = useMediaQuery(theme.breakpoints.down(1024));
  const authUserName = authUserNameProp ?? null;
  const [activeFeedId, setActiveFeedId] = useState<string | null>(null);
  const [createMessageOpen, setCreateMessageOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{ id: number; message: InboxMessage } | null>(null);
  const [editAsReport, setEditAsReport] = useState(false);
  const [reportSource, setReportSource] = useState<{ id: number; message: InboxMessage } | null>(
    null,
  );
  const { notify } = usePowerSnackbar();
  const {
    currentUser,
    cyberEchoEnabled,
    tagsLayout,
    audioTranscriptionCollapsed,
    audioTranscriptionEnabled,
    collapseMediaPreviews,
    mediaSummaryEnabled,
    messageTextPreviewLines,
  } = useRerDutyPageSettings();
  const openReportEditor = useCallback(
    async (reportId: number) => {
      try {
        const [report] = await fetchMessagesByIds([reportId]);
        if (!report) throw new Error('Розвіддонесення не знайдено.');
        setCreateMessageOpen(false);
        setReportSource(null);
        setEditAsReport(true);
        setEditTarget({ id: report[0], message: report[1] });
      } catch (loadError) {
        notify({
          message:
            loadError instanceof Error ? loadError.message : 'Не вдалося відкрити розвіддонесення.',
          severity: 'error',
        });
      }
    },
    [notify],
  );
  const openMessageEditor = useCallback((target: { id: number; message: InboxMessage }) => {
    setCreateMessageOpen(false);
    setReportSource(null);
    setEditAsReport(false);
    setEditTarget(target);
  }, []);
  const openReportComposer = useCallback((source: { id: number; message: InboxMessage }) => {
    setCreateMessageOpen(false);
    setEditAsReport(false);
    setEditTarget(null);
    setReportSource(source);
  }, []);
  const previousFeedCountRef = useRef(0);
  const feeds = useRerDutyFeeds(authUserName, currentUser?.organismId ?? null);
  const {
    messageFeeds,
    error,
    clearDutyError,
    columnRefsRef,
    nearBottomByFeedIdRef,
    confirmedTailPreviewByFeedId,
    createMessageFeed,
    reloadEmptyFeeds,
    reloadFeeds,
    reloadEditedFeeds,
    flushPendingNewerMessages,
    handleEditedMessage,
    handleDeleteConfirm,
    setDeleteConfirmId,
    setDeleteConfirmFeedId,
    deleteConfirmId,
  } = feeds;

  const buildFeedColumnModel = useDutyFeedColumnModel({
    feeds,
    narrowScreen,
    authUserName,
    currentUser,
    tagsLayout,
    collapseMediaPreviews,
    mediaSummaryEnabled,
    messageTextPreviewLines,
    openReportEditor: (reportId) => {
      void openReportEditor(reportId);
    },
    openMessageEditor,
    openReportComposer,
  });

  const activeFeedIdSafe = messageFeeds.some((feed) => feed.id === activeFeedId)
    ? activeFeedId
    : (messageFeeds[0]?.id ?? null);
  const previousActiveFeedIdForFlushRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeFeedIdSafe) return;
    // Desktop/narrow active-only: remounting a column should surface buffered newer pages.
    if (previousActiveFeedIdForFlushRef.current === activeFeedIdSafe) return;
    previousActiveFeedIdForFlushRef.current = activeFeedIdSafe;
    flushPendingNewerMessages(activeFeedIdSafe, { urgent: true });
  }, [activeFeedIdSafe, flushPendingNewerMessages]);
  const [hasCompletedInitialLoad, setHasCompletedInitialLoad] = useState(false);
  const openCreateMessageComposer = useCallback(() => {
    setEditTarget(null);
    setEditAsReport(false);
    setReportSource(null);
    setCreateMessageOpen(true);
  }, []);
  const closeMessageEditor = useCallback(() => {
    setCreateMessageOpen(false);
    setEditTarget(null);
    setEditAsReport(false);
    setReportSource(null);
  }, []);
  const handleCreatedMessage = useCallback(() => {
    setCreateMessageOpen(false);
    // Do not reloadFeeds(): that re-pins the scroller to the bottom.
    reloadEmptyFeeds();
    notify({
      message: reportSource
        ? 'Розвіддонесення успішно створено.'
        : 'Повідомлення успішно створено.',
      severity: 'success',
    });
  }, [notify, reloadEmptyFeeds, reportSource]);

  useEffect(() => {
    if (
      !hasCompletedInitialLoad &&
      messageFeeds.length > 0 &&
      messageFeeds.every((feed) => !feed.loading)
    ) {
      setHasCompletedInitialLoad(true);
    }
  }, [hasCompletedInitialLoad, messageFeeds]);

  useEffect(() => {
    if (messageFeeds.length === 0) {
      setActiveFeedId(null);
      previousFeedCountRef.current = 0;
      return;
    }
    setActiveFeedId((current) => {
      const currentExists = isPresent(current) && messageFeeds.some((feed) => feed.id === current);
      if (messageFeeds.length > previousFeedCountRef.current) {
        return messageFeeds[messageFeeds.length - 1].id;
      }
      if (currentExists) return current;
      return messageFeeds[0].id;
    });
    previousFeedCountRef.current = messageFeeds.length;
  }, [messageFeeds]);

  const dutyTabUnreadTotal = useMemo(
    () =>
      messageFeeds.reduce(
        (total, feed) =>
          total +
          feedIndicatorUnreadCount(feed, confirmedTailPreviewByFeedId[feed.id], {
            includeBeyondTailResidual: nearBottomByFeedIdRef.current[feed.id] !== true,
          }),
        0,
      ),
    [messageFeeds, confirmedTailPreviewByFeedId, nearBottomByFeedIdRef],
  );
  const anyFeedInitialLoading = messageFeeds.some(
    (feed) => feed.loading && feed.items.length === 0,
  );
  const anyFeedReloading = messageFeeds.some((feed) => feed.loading && feed.items.length > 0);
  const isInitialLoading = !hasCompletedInitialLoad && anyFeedInitialLoading;
  const showLoadingBackdrop = hasCompletedInitialLoad && anyFeedReloading;
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
        position: 'relative',
      }}
    >
      <Box className="flex items-center justify-between flex-wrap gap-2 mb-2 shrink-0" />

      {error ? (
        <PowerAlert
          severity="error"
          className="mb-2 shrink-0"
          onClose={() => clearDutyError()}
          role="alert"
          autoHideDuration={10000}
        >
          {error}
        </PowerAlert>
      ) : null}

      <PointBlacklistPaletteNamesCacheProvider>
        <AudioTranscriptionPreferencesProvider
          collapsedByDefault={audioTranscriptionCollapsed}
          enabled={audioTranscriptionEnabled}
        >
          <RerDutyNeoWorkspace
            activeFeedId={activeFeedIdSafe}
            buildFeedColumnModel={buildFeedColumnModel}
            columnRefsRef={columnRefsRef}
            createMessageFeed={createMessageFeed}
            openCreateMessageComposer={openCreateMessageComposer}
            isInitialLoading={isInitialLoading}
            messageFeeds={messageFeeds}
            narrowScreen={narrowScreen}
            onSelectFeed={setActiveFeedId}
            showLoadingBackdrop={showLoadingBackdrop}
          />
        </AudioTranscriptionPreferencesProvider>
      </PointBlacklistPaletteNamesCacheProvider>

      <ManageMessageDrawer
        open={createMessageOpen || isPresent(editTarget) || isPresent(reportSource)}
        cyberEchoEnabled={cyberEchoEnabled}
        currentUser={currentUser}
        editTarget={editTarget}
        editAsReport={editAsReport}
        reportSource={reportSource}
        onClose={closeMessageEditor}
        onSubmitEdit={
          editTarget && !editAsReport
            ? async (messageId, message) => {
                handleEditedMessage(messageId, message);
              }
            : undefined
        }
        onEditSuccess={() => {
          if (editAsReport) {
            reloadFeeds();
          } else {
            reloadEditedFeeds();
          }
        }}
        onDeleteSuccess={() => {
          reloadFeeds();
          notify({ message: 'Розвіддонесення успішно видалено.', severity: 'success' });
        }}
        onCreated={handleCreatedMessage}
      />

      <DeleteConfirmDialog
        open={isPresent(deleteConfirmId)}
        onClose={() => {
          setDeleteConfirmId(null);
          setDeleteConfirmFeedId(null);
        }}
        onConfirm={handleDeleteConfirm}
      />
    </Box>
  );
}
