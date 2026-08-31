import { Box } from '@mui/material';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MouseEvent } from 'react';
import {
  DUTY_AUDIO_STATUS_CHANGE_EVENT,
  getStoredDutyNotificationSettingsForFeed,
  getDutyNotificationBellState,
  requestBrowserNotificationPermission,
  resumeDutyNotificationAudioFromUserGesture,
  setStoredDutyNotificationSettingsForFeed,
} from './notifications';
import { FeedColumnHeader } from './FeedColumnHeader';
import { FeedColumnContent, type FeedColumnContentHandle } from './FeedColumnContent';
import { useDocumentClickAway } from '../../hooks/use-document-click-away';
import { ConfirmDangerDialog } from '../../components/ConfirmDangerDialog';
import type { FeedColumnModel } from './types';
import { DutyScrollDebugPanel } from './DutyScrollDebugPanel';
import { registerDutyScrollDebugBellPress } from './duty-scroll-debug';
import { clearFeedColumnFab, publishFeedColumnFab } from './feedColumnFab';

export type FeedColumnProps = {
  column: FeedColumnModel;
};

export type FeedColumnScrollOptions = {
  /** Wake idle offload before scrolling (scroll FAB / arrow). Follow/settle omit this. */
  wakeIdleOffload?: boolean;
};

export type FeedColumnHandle = {
  scrollToEnd: (behavior?: ScrollBehavior, options?: FeedColumnScrollOptions) => void;
};
export const FeedColumn = forwardRef<FeedColumnHandle, FeedColumnProps>(function FeedColumn(
  { column },
  ref,
) {
  const { feed, view, filterPanel, keywordsPanel, actions } = column;
  const { narrowScreen = false, canRemove, maxWidth, feedCount = 1 } = view;
  const { onRemoveColumn, onCreateFeed } = actions;
  const [showFilters, setShowFilters] = useState(false);
  const [showNotificationPanel, setShowNotificationPanel] = useState(false);
  const [showKeywordsPanel, setShowKeywordsPanel] = useState(false);
  const [removeConfirmationOpen, setRemoveConfirmationOpen] = useState(false);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const filtersPanelRef = useRef<HTMLDivElement | null>(null);
  const notificationPanelRef = useRef<HTMLDivElement | null>(null);
  const keywordsPanelRef = useRef<HTMLDivElement | null>(null);
  const [notificationStorageSyncKey, setNotificationStorageSyncKey] = useState(0);
  const [notificationStatusVersion, setNotificationStatusVersion] = useState(0);
  const [notificationStorageError, setNotificationStorageError] = useState<string | null>(null);
  const refreshNotificationStatus = useCallback(() => {
    setNotificationStatusVersion((version) => version + 1);
  }, []);
  const bumpNotificationStorageSync = useCallback(() => {
    setNotificationStorageSyncKey((k) => k + 1);
  }, []);
  const dutyNotificationSummary = useMemo(
    () => getStoredDutyNotificationSettingsForFeed(feed.id),
    [feed.id, notificationStorageSyncKey],
  );
  const dutyNotificationBellState = useMemo(
    () => getDutyNotificationBellState(dutyNotificationSummary),
    [dutyNotificationSummary, notificationStatusVersion],
  );
  useEffect(() => {
    const refresh = () => setNotificationStatusVersion((version) => version + 1);
    window.addEventListener('focus', refresh);
    window.addEventListener(DUTY_AUDIO_STATUS_CHANGE_EVENT, refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(DUTY_AUDIO_STATUS_CHANGE_EVENT, refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const handleBellToggleDutyNotifications = useCallback(
    async (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
      registerDutyScrollDebugBellPress();
      const cur = getStoredDutyNotificationSettingsForFeed(feed.id);
      if (cur.soundEnabled || cur.browserEnabled) {
        const result = setStoredDutyNotificationSettingsForFeed(feed.id, {
          soundEnabled: false,
          browserEnabled: false,
        });
        if (result.ok) {
          setNotificationStorageError(null);
          bumpNotificationStorageSync();
        } else {
          setNotificationStorageError(result.error);
          setShowNotificationPanel(true);
        }
        return;
      }
      resumeDutyNotificationAudioFromUserGesture();
      const permission = await requestBrowserNotificationPermission();
      const browserEnabled = permission === 'granted';
      const result = setStoredDutyNotificationSettingsForFeed(feed.id, {
        soundEnabled: true,
        browserEnabled,
      });
      if (result.ok) {
        setNotificationStorageError(null);
        bumpNotificationStorageSync();
      } else {
        setNotificationStorageError(result.error);
        setShowNotificationPanel(true);
      }
    },
    [feed.id, bumpNotificationStorageSync],
  );
  const contentRef = useRef<FeedColumnContentHandle | null>(null);
  const closeFilters = useCallback(() => {
    setShowFilters(false);
  }, []);
  const closeNotificationPanel = useCallback(() => {
    setShowNotificationPanel(false);
  }, []);
  const closeKeywordsPanel = useCallback(() => {
    setShowKeywordsPanel(false);
  }, []);
  const closeOtherPanels = useCallback((except: 'filters' | 'notifications' | 'keywords') => {
    if (except !== 'filters') setShowFilters(false);
    if (except !== 'notifications') setShowNotificationPanel(false);
    if (except !== 'keywords') setShowKeywordsPanel(false);
  }, []);
  const onToggleFilters = useCallback(() => {
    setShowFilters((open) => {
      const next = !open;
      if (next) closeOtherPanels('filters');
      return next;
    });
  }, [closeOtherPanels]);
  const onToggleNotificationPanel = useCallback(() => {
    if (feedCount >= 4) registerDutyScrollDebugBellPress();
    setShowNotificationPanel((open) => {
      const next = !open;
      if (next) closeOtherPanels('notifications');
      return next;
    });
  }, [closeOtherPanels, feedCount]);
  const onToggleKeywordsPanel = useCallback(() => {
    setShowKeywordsPanel((open) => {
      const next = !open;
      if (next) closeOtherPanels('keywords');
      return next;
    });
  }, [closeOtherPanels]);
  const handleCloseAction = useCallback(() => {
    if (showFilters || showNotificationPanel || showKeywordsPanel) {
      setShowFilters(false);
      setShowNotificationPanel(false);
      setShowKeywordsPanel(false);
      return;
    }
    setRemoveConfirmationOpen(true);
  }, [showFilters, showNotificationPanel, showKeywordsPanel]);
  const handleRemoveConfirmed = useCallback(() => {
    setRemoveConfirmationOpen(false);
    onRemoveColumn();
  }, [onRemoveColumn]);
  const shouldDismissPanelClick = useCallback((event: globalThis.MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return true;
    const clickedColumn = target.closest('[data-duty-feed-column]');
    if (clickedColumn && clickedColumn !== columnRef.current) return false;
    return true;
  }, []);
  useDocumentClickAway({
    enabled: showFilters,
    refs: [columnRef],
    ignoreSelectors: ['.MuiModal-root', '.MuiPopover-root'],
    shouldDismiss: shouldDismissPanelClick,
    onClickAway: closeFilters,
  });
  useDocumentClickAway({
    enabled: showNotificationPanel,
    refs: [columnRef],
    ignoreSelectors: ['.MuiModal-root', '.MuiPopover-root'],
    shouldDismiss: shouldDismissPanelClick,
    onClickAway: closeNotificationPanel,
  });
  useDocumentClickAway({
    enabled: showKeywordsPanel,
    refs: [columnRef],
    ignoreSelectors: ['.MuiModal-root', '.MuiPopover-root'],
    shouldDismiss: shouldDismissPanelClick,
    onClickAway: closeKeywordsPanel,
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd(behavior: ScrollBehavior = 'smooth', options?: FeedColumnScrollOptions) {
        if (feed.items.length === 0) return;
        contentRef.current?.scrollToBottom(behavior, options);
      },
    }),
    [feed.items.length],
  );

  // FAB badge/arrow state bypasses FeedColumnContent memo so poll/unread ticks don't rebuild the list.
  // Publish after render — sync emit during render updates FeedColumnScrollFab mid-tree.
  useLayoutEffect(() => {
    publishFeedColumnFab(feed.id, {
      bottomUnreadCount: view.bottomUnreadCount ?? 0,
      arrowResultMessage: view.arrowResultMessage ?? null,
      tailAvailability: view.tailAvailability ?? 'unknown',
    });
  }, [feed.id, view.arrowResultMessage, view.bottomUnreadCount, view.tailAvailability]);

  useEffect(() => () => clearFeedColumnFab(feed.id), [feed.id]);

  return (
    <Box
      ref={columnRef}
      data-duty-feed-column
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
        feedCount={feedCount}
        canRemove={canRemove}
        showFilters={showFilters}
        showNotificationPanel={showNotificationPanel}
        showKeywordsPanel={showKeywordsPanel}
        dutyNotificationBellState={dutyNotificationBellState}
        onCreateFeed={onCreateFeed}
        onToggleFilters={onToggleFilters}
        onToggleNotificationPanel={onToggleNotificationPanel}
        onToggleKeywordsPanel={onToggleKeywordsPanel}
        onToggleDutyNotifications={handleBellToggleDutyNotifications}
        onRemoveColumn={handleCloseAction}
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
        notificationStorageError={notificationStorageError}
        onNotificationStorageErrorChange={setNotificationStorageError}
        onNotificationStatusChanged={refreshNotificationStatus}
      />
      <FeedColumnContent ref={contentRef} column={column} />
      <DutyScrollDebugPanel feed={feed} view={view} />
      {removeConfirmationOpen ? (
        <ConfirmDangerDialog
          open
          onClose={() => setRemoveConfirmationOpen(false)}
          onConfirm={handleRemoveConfirmed}
          maxWidth="xs"
          description="Ви впевнені, що хочете видалити цю стрічку?"
        />
      ) : null}
    </Box>
  );
});
