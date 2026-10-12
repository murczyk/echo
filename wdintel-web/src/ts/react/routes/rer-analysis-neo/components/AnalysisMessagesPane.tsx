import { Box } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { MessageFeed, type MessageFeedHandle } from '../../shared/message-feed';
import { useAnalysisMessageFeed } from './useAnalysisMessageFeed';
import { AnalysisMessageCardItem, type BotTagAction } from './AnalysisMessageCardItem';
import { isNullOrUndefined, isPresent } from '../../../utils/misc';
import type {
  CallsignInfoRes,
  InboxMessage,
  MessageComment,
  Network,
  SignalGroupEntry,
  SignalProfileEntry,
  Tag,
  Unit,
  User,
} from '../../../../../Bindings';
import { DeleteConfirmDialog } from '../../rer-duty-neo/dialogs';
import {
  scrollToAndHighlightMessage,
  type MessageCardEtalonDisplayModel,
} from '../../shared/message-card/message-card.utils';
import { blurActiveElement } from '../../../utils/focus';
import { PowerAlert } from '../../../components/PowerAlert';
import type { TagsLayoutVariant } from '../../rer-duty-neo/utils';
import type { MessageTimeBasis } from '../../../services/api/user-settings';
import type { AddPointHighlightBlacklistRequest } from '../../shared/message-card/point-highlight-blacklist';
import type { AnalysisDirectMessageNavigation } from '../types';
import { DEFAULT_MEDIA_SUMMARY_ENABLED } from '../../../hooks/duty-settings-defaults';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { DEBUG_SCROLL_HEARTBEAT_MS } from '../../../../debug-recorder/config';
import { recordAnalysisDebugScrollSnapshot, useAnalysisDebugEnabled } from '../analysis-debug';

type Props = {
  authUserName: string | null;
  currentUser: User | null;
  copiedFeedbackId: string | null;
  botTagAction?: BotTagAction | null;
  groupInfos: Record<string, SignalGroupEntry>;
  paginationLoading: boolean;
  isLoading?: boolean;
  messageComments: Record<number, MessageComment[]>;
  messages: Array<[number, InboxMessage]>;
  networkDisplayMap: Record<number, string>;
  pageIndex: number;
  pageNavigationTarget: number | null;
  viewportPreservationKey: number;
  onViewportCaptureChange: (capture: (() => void) | null) => void;
  scrollResetKey: string;
  noMoreToLoad: boolean;
  onDeleteMessage: (messageId: number) => void;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void;
  onOpenEditor: (messageId: number, focusTarget?: HTMLElement) => void;
  onCreateReport: (
    messageId: number,
    etalonDisplayModel: MessageCardEtalonDisplayModel,
    focusTarget: HTMLElement,
  ) => void;
  onEditReport: (messageId: number) => void | Promise<void>;
  onLoadMoreMessages: () => Promise<boolean>;
  onVisiblePageChange: (pageIndex: number) => void;
  onPageNavigationHandled: () => void;
  onOpenPointsOnMap: (etalons: string[], message: InboxMessage) => void;
  onAddPointHighlightBlacklist: (request: AddPointHighlightBlacklistRequest) => Promise<void>;
  onSaveMessageUpdate: (
    messageId: number,
    updater: (message: InboxMessage) => InboxMessage,
  ) => Promise<boolean>;
  onToggleMessageBookmark: (messageId: number, currentlyBookmarked: boolean) => void;
  onToggleMessageImportant: (messageId: number, currentlyImportant: boolean) => void;
  onToggleMessageTag: (messageId: number, tagId: number) => void;
  profiles: Record<string, SignalProfileEntry | null>;
  tagsMap: Record<number, Tag>;
  tagsOrder: number[];
  tagsLoading: boolean;
  tagsLayout: TagsLayoutVariant;
  hideBotTags: boolean;
  hideNetworks: boolean;
  messageTimeBasis?: MessageTimeBasis;
  mediaSummaryEnabled?: boolean;
  collapseMediaPreviews: boolean;
  messageTextPreviewLines: 20 | 40 | null;
  showCallsignAddForm: boolean;
  searchText?: string | null;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
  directMessageNavigation: AnalysisDirectMessageNavigation | null;
};

const getMessageId = ([id]: [number, InboxMessage]) => id;

function AnalysisMessagesPaneComponent({
  authUserName,
  currentUser,
  copiedFeedbackId: copiedFeedbackIdProp,
  botTagAction,
  groupInfos,
  paginationLoading,
  isLoading = false,
  messageComments,
  messages,
  networkDisplayMap,
  pageIndex,
  pageNavigationTarget,
  viewportPreservationKey,
  onViewportCaptureChange,
  scrollResetKey,
  noMoreToLoad,
  onDeleteMessage,
  onCancelBotTagAction,
  onMarkBotTagWrong,
  onOpenEditor,
  onCreateReport,
  onEditReport,
  onLoadMoreMessages,
  onVisiblePageChange,
  onPageNavigationHandled,
  onOpenPointsOnMap,
  onAddPointHighlightBlacklist,
  onSaveMessageUpdate,
  onToggleMessageBookmark,
  onToggleMessageImportant,
  onToggleMessageTag,
  profiles,
  tagsMap,
  tagsOrder,
  tagsLoading,
  tagsLayout,
  hideBotTags,
  hideNetworks,
  messageTimeBasis,
  mediaSummaryEnabled = DEFAULT_MEDIA_SUMMARY_ENABLED,
  collapseMediaPreviews,
  messageTextPreviewLines,
  showCallsignAddForm,
  searchText,
  callsignInfoMap,
  networks,
  unitsMap,
  directMessageNavigation,
}: Props) {
  const theme = useTheme();
  const { notify } = useOptionalPowerSnackbar();
  const analysisDebugEnabled = useAnalysisDebugEnabled();
  const [copiedFeedbackId, setCopiedFeedbackId] = useState<string | null>(copiedFeedbackIdProp);
  const [deleteMessageId, setDeleteMessageId] = useState<number | null>(null);
  const referenceTimeMsRef = useRef<number | null>(Date.now());
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const debugSnapshotTimerRef = useRef<number | null>(null);
  const clearTargetHighlightRef = useRef<(() => void) | null>(null);
  const highlightedTargetIdRef = useRef<number | null>(null);
  const feedRef = useRef<MessageFeedHandle>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const currentUserLogin = authUserName?.trim() || currentUser?.name?.trim() || null;
  const {
    scrollOptions,
    displayedMessages,
    loadingAbove: focusedLoadingAbove,
    loadingBelow: focusedLoadingBelow,
    hasMoreAbove,
    hasMoreBelow,
  } = useAnalysisMessageFeed({
    messages,
    directMessageNavigation,
    pageIndex,
    pageNavigationTarget,
    viewportPreservationKey,
    onViewportCaptureChange,
    scrollResetKey,
    paginationLoading,
    noMoreToLoad,
    onLoadMoreMessages,
    onVisiblePageChange,
    onPageNavigationHandled,
  });
  const recordDebugScrollSnapshot = useCallback(() => {
    const container = scrollerRef.current;
    if (!analysisDebugEnabled || container == null) return;
    recordAnalysisDebugScrollSnapshot(container, {
      pageIndex,
      paginationLoading,
      noMoreToLoad,
      directMessageActive: directMessageNavigation != null,
      directMessageFocusActive: directMessageNavigation?.focusActive === true,
      viewportAnchorActive:
        directMessageNavigation != null && directMessageNavigation.focusActive === false,
      targetAnchorPreserved: directMessageNavigation?.focusActive === true,
      bottomAnchorSpacerPx: feedRef.current?.getBottomSpacerPx() ?? 0,
    });
  }, [analysisDebugEnabled, directMessageNavigation, noMoreToLoad, pageIndex, paginationLoading]);
  const scheduleDebugScrollSnapshot = useCallback(() => {
    if (!analysisDebugEnabled) return;
    if (debugSnapshotTimerRef.current !== null) {
      window.clearTimeout(debugSnapshotTimerRef.current);
    }
    debugSnapshotTimerRef.current = window.setTimeout(() => {
      debugSnapshotTimerRef.current = null;
      recordDebugScrollSnapshot();
    }, DEBUG_SCROLL_HEARTBEAT_MS);
  }, [analysisDebugEnabled, recordDebugScrollSnapshot]);

  useLayoutEffect(() => {
    recordDebugScrollSnapshot();
  }, [messages, recordDebugScrollSnapshot]);
  useEffect(() => {
    setCopiedFeedbackId(copiedFeedbackIdProp);
  }, [copiedFeedbackIdProp]);
  useEffect(() => {
    referenceTimeMsRef.current = Date.now();
  }, [messages]);
  useEffect(
    () => () => {
      if (isPresent(copyFeedbackTimerRef.current))
        window.clearTimeout(copyFeedbackTimerRef.current);
      if (debugSnapshotTimerRef.current !== null)
        window.clearTimeout(debugSnapshotTimerRef.current);
      clearTargetHighlightRef.current?.();
    },
    [],
  );

  useEffect(() => {
    if (directMessageNavigation == null || !directMessageNavigation.focusActive) {
      clearTargetHighlightRef.current?.();
      clearTargetHighlightRef.current = null;
      highlightedTargetIdRef.current = null;
      return;
    }
    if (
      highlightedTargetIdRef.current === directMessageNavigation.targetMessageId ||
      messages.length === 0
    )
      return;
    const targetElement = feedRef.current?.getItemElement(directMessageNavigation.targetMessageId);
    if (targetElement) {
      clearTargetHighlightRef.current?.();
      highlightedTargetIdRef.current = directMessageNavigation.targetMessageId;
      clearTargetHighlightRef.current = scrollToAndHighlightMessage(targetElement, {
        scroll: false,
        persistentHighlight: true,
      });
    }
  }, [directMessageNavigation, messages]);

  const showCopiedFeedback = useCallback(
    (value: string) => {
      if (isPresent(copyFeedbackTimerRef.current)) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
      setCopiedFeedbackId(value);
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setCopiedFeedbackId((current) => (current === value ? null : current));
        copyFeedbackTimerRef.current = null;
      }, 1000);
      if (value.startsWith('link-')) {
        notify({ severity: 'success', message: 'Посилання на повідомлення скопійовано.' });
      }
    },
    [notify],
  );

  const handleDeleteOpen = useCallback(
    (messageId: number) => {
      blurActiveElement();
      setDeleteMessageId(messageId);
    },
    [blurActiveElement],
  );

  const handleOpenEditor = useCallback(
    (messageId: number, focusTarget?: HTMLElement) => {
      onOpenEditor(messageId, focusTarget);
    },
    [onOpenEditor],
  );

  if (messages.length === 0 && !isLoading) {
    return (
      <Box sx={{ flex: 1, minHeight: 0, px: 0 }}>
        <PowerAlert severity="info" sx={{ width: '100%', boxSizing: 'border-box' }}>
          Немає жодного повідомлення для аналізу.
        </PowerAlert>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        flex: 1,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        px: 0,
        position: 'relative',
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      <MessageFeed
        ref={feedRef}
        scrollerRef={scrollerRef}
        scrollOptions={scrollOptions}
        items={displayedMessages}
        getMessageId={getMessageId}
        isLoading={isLoading}
        loadingAbove={focusedLoadingAbove || Boolean(directMessageNavigation?.contextLoading)}
        loadingBelow={
          focusedLoadingBelow ||
          Boolean(directMessageNavigation?.contextLoading) ||
          (directMessageNavigation == null && paginationLoading)
        }
        hasMoreAbove={hasMoreAbove}
        hasMoreBelow={hasMoreBelow}
        listTag="ul"
        scrollerProps={{
          'data-analysis-message-scroller': true,
          tabIndex: directMessageNavigation?.focusActive ? 0 : undefined,
          className: 'analysis-message-feed',
          onScroll: scheduleDebugScrollSnapshot,
          style: {
            '--message-feed-scrollbar-thumb': alpha(
              theme.palette.text.primary,
              theme.palette.mode === 'light' ? 0.28 : 0.38,
            ),
          } as CSSProperties,
        }}
        renderMessage={([id, message]) => (
          <AnalysisMessageCardItem
            key={id}
            authUserName={authUserName}
            currentUserLogin={currentUserLogin}
            copiedFeedbackId={copiedFeedbackId}
            botTagAction={botTagAction}
            groupInfos={groupInfos}
            id={id}
            message={message}
            messageComments={messageComments[id] ?? []}
            networkDisplayMap={networkDisplayMap}
            onCreateReport={onCreateReport}
            onEditReport={onEditReport}
            onCopyFeedback={showCopiedFeedback}
            onDeleteOpen={handleDeleteOpen}
            onOpenPointsOnMap={onOpenPointsOnMap}
            onAddPointHighlightBlacklist={onAddPointHighlightBlacklist}
            onCancelBotTagAction={onCancelBotTagAction}
            onMarkBotTagWrong={onMarkBotTagWrong}
            onOpenEditor={handleOpenEditor}
            onSaveMessageUpdate={onSaveMessageUpdate}
            onToggleMessageBookmark={onToggleMessageBookmark}
            onToggleMessageImportant={onToggleMessageImportant}
            onToggleMessageTag={onToggleMessageTag}
            profiles={profiles}
            referenceTimeMs={referenceTimeMsRef.current}
            tagsMap={tagsMap}
            tagsOrder={tagsOrder}
            tagsLoading={tagsLoading}
            tagsLayout={tagsLayout}
            hideBotTags={hideBotTags}
            hideNetworks={hideNetworks}
            messageTimeBasis={messageTimeBasis}
            mediaSummaryEnabled={mediaSummaryEnabled}
            collapseMediaPreviews={collapseMediaPreviews}
            messageTextPreviewLines={messageTextPreviewLines}
            showCallsignAddForm={showCallsignAddForm}
            searchText={searchText}
            callsignInfoMap={callsignInfoMap}
            networks={networks}
            unitsMap={unitsMap}
          />
        )}
      />

      <DeleteConfirmDialog
        open={isPresent(deleteMessageId)}
        onClose={() => setDeleteMessageId(null)}
        onConfirm={() => {
          if (isNullOrUndefined(deleteMessageId)) return;
          onDeleteMessage(deleteMessageId);
          setDeleteMessageId(null);
        }}
      />
    </Box>
  );
}

export const AnalysisMessagesPane = memo(AnalysisMessagesPaneComponent);
