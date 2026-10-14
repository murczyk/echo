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
  DUTY_NOTIFICATION_STATUS_CHANGE_EVENT,
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
import { clearFeedColumnFab, publishFeedColumnFab } from './feedColumnFab';
import { feedHasUnloadedEvictedNewerTail } from './utils';
import type { ExplicitScrollNavigation, ScrollNavigationIntent } from '../shared/message-feed';
import { recordDutyScrollDebugSnapshot, useDutyScrollDebugEnabled } from './duty-scroll-debug';
import {
  GroupIsland,
  GroupPanel,
  isDutyGroupViewAcknowledgeable,
  useGroupFeedNavigation,
  type GroupNavigationItem,
  type GroupScope,
} from '../shared/group-navigation';
import { CreateMessageFab } from '../shared/manage-message/CreateMessageFab';
import { POWER_FLOATING_CONTROL_EDGE_INSET } from '../shared/manage-message/floating-control-geometry';

export type FeedColumnProps = {
  column: FeedColumnModel;
  onPanelOpenChange?: (feedId: string, panelOpen: boolean) => void;
};

export type FeedColumnScrollOptions = {
  /** Wake idle offload before scrolling (scroll FAB / arrow). Follow/settle omit this. */
  wakeIdleOffload?: boolean;
  intent?: ScrollNavigationIntent;
  navigation?: ExplicitScrollNavigation;
};

export type FeedColumnHandle = {
  scrollToEnd: (behavior?: ScrollBehavior, options?: FeedColumnScrollOptions) => void;
  scrollToMessage?: (id: number, behavior?: ScrollBehavior) => HTMLElement | null;
  highlightLinkedMessage?: (id: number) => boolean;
};

const DEFAULT_GROUP_NAVIGATION: NonNullable<FeedColumnModel['groupNavigation']> = {
  scope: { kind: 'all' },
  groupName: 'Всі групи',
  onSelect: () => {},
  onError: () => {},
};

export const FeedColumn = forwardRef<FeedColumnHandle, FeedColumnProps>(function FeedColumn(
  { column, onPanelOpenChange },
  ref,
) {
  const { feed, view, filterPanel, keywordsPanel, actions } = column;
  const groupNavigation = column.groupNavigation ?? DEFAULT_GROUP_NAVIGATION;
  const dutyScrollDebugEnabled = useDutyScrollDebugEnabled();
  const { narrowScreen = false, canRemove, maxWidth, feedCount = 1 } = view;
  const { onRemoveColumn, onCreateFeed } = actions;
  const [showFilters, setShowFilters] = useState(false);
  const [showNotificationPanel, setShowNotificationPanel] = useState(false);
  const [showKeywordsPanel, setShowKeywordsPanel] = useState(false);
  const [showGroups, setShowGroups] = useState(false);
  const [removeConfirmationOpen, setRemoveConfirmationOpen] = useState(false);
  const columnRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const filtersPanelRef = useRef<HTMLDivElement | null>(null);
  const notificationPanelRef = useRef<HTMLDivElement | null>(null);
  const keywordsPanelRef = useRef<HTMLDivElement | null>(null);
  const groupsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const groupAckControllerRef = useRef<AbortController | null>(null);
  const navigation = useGroupFeedNavigation({
    enabled: showGroups,
    scope: groupNavigation.scope,
    onSelect: () => {},
    onError: groupNavigation.onError,
  });
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
    window.addEventListener(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT, refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT, refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  useEffect(() => {
    if (!dutyScrollDebugEnabled) return;
    recordDutyScrollDebugSnapshot(feed, view);
  }, [dutyScrollDebugEnabled, feed, view]);
  const handleBellToggleDutyNotifications = useCallback(
    async (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.stopPropagation();
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
  const closeOpenPanels = useCallback(() => {
    setShowFilters(false);
    setShowNotificationPanel(false);
    setShowKeywordsPanel(false);
    setShowGroups(false);
  }, []);
  const closeOtherPanels = useCallback(
    (except: 'filters' | 'notifications' | 'keywords' | 'groups') => {
      if (except !== 'filters') setShowFilters(false);
      if (except !== 'notifications') setShowNotificationPanel(false);
      if (except !== 'keywords') setShowKeywordsPanel(false);
      if (except !== 'groups') setShowGroups(false);
    },
    [],
  );
  const onToggleFilters = useCallback(() => {
    setShowFilters((open) => {
      const next = !open;
      if (next) closeOtherPanels('filters');
      return next;
    });
  }, [closeOtherPanels]);
  const onToggleNotificationPanel = useCallback(() => {
    setShowNotificationPanel((open) => {
      const next = !open;
      if (next) closeOtherPanels('notifications');
      return next;
    });
  }, [closeOtherPanels]);
  const onToggleKeywordsPanel = useCallback(() => {
    setShowKeywordsPanel((open) => {
      const next = !open;
      if (next) closeOtherPanels('keywords');
      return next;
    });
  }, [closeOtherPanels]);
  const onToggleGroups = useCallback(() => {
    setShowGroups((open) => {
      const next = !open;
      if (next) closeOtherPanels('groups');
      return next;
    });
  }, [closeOtherPanels]);
  const handleCloseAction = useCallback(() => {
    if (showFilters || showNotificationPanel || showKeywordsPanel || showGroups) {
      closeOpenPanels();
      return;
    }
    setRemoveConfirmationOpen(true);
  }, [closeOpenPanels, showFilters, showGroups, showNotificationPanel, showKeywordsPanel]);
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
    refs: [headerRef, filtersPanelRef],
    ignoreSelectors: ['.MuiModal-root', '.MuiPopover-root'],
    shouldDismiss: shouldDismissPanelClick,
    onClickAway: closeFilters,
  });
  useDocumentClickAway({
    enabled: showNotificationPanel,
    refs: [headerRef, notificationPanelRef],
    ignoreSelectors: ['.MuiModal-root', '.MuiPopover-root'],
    shouldDismiss: shouldDismissPanelClick,
    onClickAway: closeNotificationPanel,
  });
  useDocumentClickAway({
    enabled: showKeywordsPanel,
    refs: [headerRef, keywordsPanelRef],
    ignoreSelectors: ['.MuiModal-root', '.MuiPopover-root'],
    shouldDismiss: shouldDismissPanelClick,
    onClickAway: closeKeywordsPanel,
  });

  useEffect(() => {
    if (!showFilters && !showNotificationPanel && !showKeywordsPanel && !showGroups) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) closeOpenPanels();
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [closeOpenPanels, showFilters, showGroups, showKeywordsPanel, showNotificationPanel]);

  const panelOpen = showFilters || showNotificationPanel || showKeywordsPanel || showGroups;
  useEffect(() => {
    onPanelOpenChange?.(feed.id, panelOpen);
  }, [feed.id, onPanelOpenChange, panelOpen]);
  useEffect(
    () => () => {
      onPanelOpenChange?.(feed.id, false);
    },
    [feed.id, onPanelOpenChange],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd(behavior: ScrollBehavior = 'smooth', options?: FeedColumnScrollOptions) {
        if (feed.items.length === 0) return;
        contentRef.current?.scrollToBottom(behavior, options);
      },
      scrollToMessage(id: number, behavior: ScrollBehavior = 'auto') {
        return contentRef.current?.scrollToMessage(id, behavior) ?? null;
      },
      highlightLinkedMessage(id: number) {
        return contentRef.current?.highlightLinkedMessage(id) ?? false;
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
      hasUnrenderedNewerMessages:
        (feed.pendingNewerItems?.length ?? 0) > 0 || feedHasUnloadedEvictedNewerTail(feed),
      explicitNavigationLoading: view.explicitNavigationLoading ?? false,
    });
  }, [
    feed.id,
    feed.items,
    feed.pendingNewerItems,
    feed.evictedNewerTailId,
    view.arrowResultMessage,
    view.bottomUnreadCount,
    view.tailAvailability,
    view.explicitNavigationLoading,
  ]);

  useEffect(() => () => clearFeedColumnFab(feed.id), [feed.id]);

  useEffect(() => {
    groupAckControllerRef.current?.abort();
    groupAckControllerRef.current = null;
  }, [feed.filter, feed.groupScopeMasterKey]);
  useEffect(
    () => () => {
      groupAckControllerRef.current?.abort();
    },
    [],
  );

  const selectedGroup: GroupNavigationItem =
    groupNavigation.scope.kind === 'group' && navigation.selectedGroup.kind === 'all'
      ? {
          kind: 'group',
          masterKey: groupNavigation.scope.masterKey,
          name: groupNavigation.groupName,
          ignoreOperativny: false,
          unreadCount: 0,
          oldestUnreadMessageRef: null,
          lastActivityAt: null,
          latestCursor: null,
        }
      : navigation.selectedGroup;
  const handleGroupSelect = useCallback(
    (scope: GroupScope) => {
      const selected = navigation.groups.find((group) =>
        scope.kind === 'all'
          ? group.kind === 'all'
          : group.kind === 'group' && group.masterKey === scope.masterKey,
      );
      setShowGroups(false);
      if (
        scope.kind === groupNavigation.scope.kind &&
        (scope.kind === 'all' ||
          (groupNavigation.scope.kind === 'group' &&
            scope.masterKey === groupNavigation.scope.masterKey))
      ) {
        return;
      }
      groupNavigation.onSelect(
        scope,
        selected?.kind === 'group' ? selected.oldestUnreadMessageRef : null,
      );
    },
    [groupNavigation, navigation.groups],
  );
  const handleReachedBottom = useCallback(
    (context: Parameters<NonNullable<typeof actions.onReachedBottom>>[0]) => {
      const result = actions.onReachedBottom?.(context);
      if (
        result === false ||
        groupNavigation.scope.kind !== 'group' ||
        navigation.selectedCursor == null ||
        !isDutyGroupViewAcknowledgeable(feed.filter) ||
        feed.adjacentFreqsRange !== 0 ||
        feed.highlightSignalsEnabled ||
        feed.onlyMyUnitTagsEnabled
      ) {
        return result;
      }
      groupAckControllerRef.current?.abort();
      const controller = new AbortController();
      groupAckControllerRef.current = controller;
      void navigation
        .acknowledge(
          {
            masterKey: groupNavigation.scope.masterKey,
            cursor: navigation.selectedCursor,
          },
          controller.signal,
        )
        .catch(() => {});
      return result;
    },
    [actions, feed, groupNavigation.scope, navigation],
  );
  const contentColumn = useMemo<FeedColumnModel>(
    () => ({
      ...column,
      actions: { ...actions, onReachedBottom: handleReachedBottom },
    }),
    [actions, column, handleReachedBottom],
  );

  return (
    <Box
      ref={columnRef}
      data-duty-feed-column
      data-duty-feed-id={feed.id}
      className={[
        'flex flex-col min-w-0 gap-0 min-h-0 h-full',
        narrowScreen ? 'shrink-0 grow-0 basis-full' : 'shrink-0',
      ].join(' ')}
      sx={{
        width: '100%',
        maxWidth: maxWidth ?? '100%',
        position: 'relative',
        scrollSnapAlign: narrowScreen ? 'start' : undefined,
        scrollSnapStop: narrowScreen ? 'always' : undefined,
        '& [data-duty-column-create-message]': {
          opacity: narrowScreen ? 1 : 0,
          visibility: narrowScreen ? 'visible' : 'hidden',
          transition: 'opacity 120ms ease',
        },
        '&:hover [data-duty-column-create-message], &:focus-within [data-duty-column-create-message]':
          {
            opacity: 1,
            visibility: 'visible',
          },
        '@media (hover: none), (pointer: coarse)': {
          '& [data-duty-column-create-message]': {
            opacity: 1,
            visibility: 'visible',
          },
        },
        '&:has([data-duty-feed-scroll-button]) [data-duty-column-create-message] .MuiFab-root': {
          right: 'auto',
          left: POWER_FLOATING_CONTROL_EDGE_INSET,
        },
      }}
    >
      <FeedColumnHeader
        narrowScreen={narrowScreen}
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
      <Box
        sx={{
          position: 'absolute',
          top: 40,
          left: '50%',
          zIndex: 3,
          maxWidth: 'calc(100% - 24px)',
          transform: 'translateX(-50%)',
        }}
      >
        <GroupIsland
          group={selectedGroup}
          expanded={showGroups}
          onOpen={onToggleGroups}
          buttonRef={groupsTriggerRef}
          panelId={`duty-group-panel-${feed.id}`}
        />
      </Box>
      <FeedColumnContent ref={contentRef} column={contentColumn} />
      <GroupPanel
        id={`duty-group-panel-${feed.id}`}
        open={showGroups}
        groups={navigation.groups}
        scope={groupNavigation.scope}
        onSelect={handleGroupSelect}
        onClose={() => setShowGroups(false)}
        triggerRef={groupsTriggerRef}
      />
      {actions.onCreateMessage && !panelOpen ? (
        <Box
          data-duty-column-create-message
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 4,
            pointerEvents: 'none',
            '& .MuiFab-root': { pointerEvents: 'auto' },
          }}
        >
          <CreateMessageFab onClick={actions.onCreateMessage} />
        </Box>
      ) : null}
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
