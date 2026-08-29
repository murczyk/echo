import { Box, Skeleton } from '@mui/material';
import { alpha, type Theme, useTheme } from '@mui/material/styles';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { AnalysisMessageCard } from '../../shared/message-card/MessageCard';
import {
  resolveMessageCardEtalonDisplayModel,
  buildCopyTextWithNetworkAndNote,
  buildCopyTextWithNetworkName,
  buildMessageLinkFullUrl,
  scrollToAndHighlightMessage,
} from '../../shared/message-card/message-card.utils';
import { buildMessageCardDisplayLabels } from '../../shared/message-card/message-card-labels';
import { blurActiveElement } from '../../../utils/focus';
import { copyMessageValue } from '../message-utils';
import { PowerAlert } from '../../../components/PowerAlert';
import type { TagsLayoutVariant } from '../../rer-duty-neo/utils';
import type { AddPointHighlightBlacklistRequest } from '../../shared/message-card/point-highlight-blacklist';
import type { AnalysisDirectMessageNavigation } from '../types';
import { ANALYSIS_MESSAGES_PAGE_SIZE, getFirstLoadedMessagesPageIndex } from '../helpers';

type BotTagAction = {
  messageId: number;
  tagId: number;
};

function filterOtherMessageComments(
  currentUserLogin: string | null,
  comments: MessageComment[],
): MessageComment[] {
  const normalizedCurrentUserLogin = currentUserLogin?.trim() ?? '';
  return comments.filter((comment) => {
    const commentLogin = comment.login.trim();
    // Analysis shows peer/post comments under the card; the current user's own
    // comment is already rendered and edited through `msg.extendedForm`.
    return commentLogin !== '' && commentLogin !== normalizedCurrentUserLogin;
  });
}

export function getAnalysisMessagesScrollSx(theme: Theme) {
  const thumbColor =
    theme.palette.mode === 'light'
      ? alpha(theme.palette.text.primary, 0.28)
      : 'rgba(255, 255, 255, 0.38)';

  return {
    height: '100%',
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    WebkitOverflowScrolling: 'touch',
    scrollbarColor: `${thumbColor} transparent`,
    '&::-webkit-scrollbar': {
      width: 12,
      height: 12,
    },
    '&::-webkit-scrollbar-track': {
      backgroundColor: 'transparent',
    },
    '&::-webkit-scrollbar-thumb': {
      backgroundColor: thumbColor,
      borderRadius: 999,
      border: '3px solid transparent',
      backgroundClip: 'content-box',
    },
    '&::-webkit-scrollbar-corner': {
      backgroundColor: 'transparent',
    },
  };
}

type Props = {
  authUserName: string | null;
  currentUser: User | null;
  copiedFeedbackId: string | null;
  botTagAction?: BotTagAction | null;
  groupInfos: Record<string, SignalGroupEntry>;
  paginationLoading: boolean;
  messageComments: Record<number, MessageComment[]>;
  messages: Array<[number, InboxMessage]>;
  networkDisplayMap: Record<number, string>;
  pageIndex: number;
  pageNavigationTarget: number | null;
  scrollResetKey: string;
  noMoreToLoad: boolean;
  onDeleteMessage: (messageId: number) => void;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void;
  onOpenEditor: (messageId: number) => void;
  onCreateReport: (messageId: number) => void;
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
  onAddFrequencyToFilter: (freq: string) => void;
  profiles: Record<string, SignalProfileEntry | null>;
  tagsMap: Record<number, Tag>;
  tagsOrder: number[];
  tagsLoading: boolean;
  tagsLayout: TagsLayoutVariant;
  mediaSummaryEnabled?: boolean;
  messageTextPreviewLines: 20 | 40 | null;
  showCallsignAddForm: boolean;
  searchText?: string | null;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
  directMessageNavigation: AnalysisDirectMessageNavigation | null;
};

function getMissingBottomScrollSpace(container: HTMLElement): number {
  const spacer = container.querySelector<HTMLElement>('[data-direct-message-anchor-spacer="true"]');
  const bottomContent = spacer?.previousElementSibling ?? container.lastElementChild;
  if (!(bottomContent instanceof HTMLElement)) return 0;
  return Math.max(
    0,
    container.getBoundingClientRect().bottom - bottomContent.getBoundingClientRect().bottom,
  );
}

function getElementVerticalCenter(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  return rect.top + (rect.height || element.offsetHeight) / 2;
}

function getContainerVerticalCenter(container: HTMLElement): number | null {
  if (container.clientHeight <= 0) return null;
  return container.getBoundingClientRect().top + container.clientTop + container.clientHeight / 2;
}

function getTargetCardElement(targetElement: HTMLElement): HTMLElement {
  return (
    targetElement.querySelector<HTMLElement>('[data-message-card-root], .message-card-root') ??
    targetElement
  );
}

const MESSAGE_PREFETCH_DISTANCE_PX = 480;

type MessageLoadPosition = 'above' | 'below';

function getFocusedLoadDirection(
  position: MessageLoadPosition,
  newestFirst: boolean,
): 'earlier' | 'later' {
  return position === 'above'
    ? newestFirst
      ? 'later'
      : 'earlier'
    : newestFirst
      ? 'earlier'
      : 'later';
}

function isNearMessageLoadPosition(container: HTMLElement, position: MessageLoadPosition): boolean {
  if (container.clientHeight <= 0) return false;
  if (position === 'above') return container.scrollTop <= MESSAGE_PREFETCH_DISTANCE_PX;
  return (
    container.scrollHeight - container.scrollTop - container.clientHeight <=
    MESSAGE_PREFETCH_DISTANCE_PX
  );
}

function MessageLoadingSkeletons({ position }: { position: MessageLoadPosition }) {
  return (
    <Box
      component="li"
      role="status"
      aria-label="Завантаження ще повідомлень"
      data-testid={`message-loading-skeletons-${position}`}
      sx={{ display: 'grid', gap: 1.5, pb: 1.5 }}
    >
      {[96, 76].map((bodyHeight, index) => (
        <Box
          key={bodyHeight}
          sx={{
            p: 1.5,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
          }}
        >
          <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
            <Skeleton variant="rounded" width={index === 0 ? 220 : 180} height={20} />
            <Skeleton variant="rounded" width={88} height={20} />
          </Box>
          <Skeleton variant="rounded" height={bodyHeight} />
          <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
            <Skeleton variant="rounded" width="45%" height={16} />
            <Skeleton variant="rounded" width="30%" height={16} />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

type AnalysisMessageCardItemProps = {
  authUserName: string | null;
  currentUserLogin: string | null;
  copiedFeedbackId: string | null;
  groupInfos: Record<string, SignalGroupEntry>;
  id: number;
  message: InboxMessage;
  messageComments: MessageComment[];
  networkDisplayMap: Record<number, string>;
  botTagAction?: BotTagAction | null;
  onCreateReport: (id: number) => void;
  onEditReport: (id: number) => void | Promise<void>;
  onCopyFeedback: (value: string) => void;
  onDeleteOpen: (messageId: number) => void;
  onOpenPointsOnMap: (etalons: string[], message: InboxMessage) => void;
  onAddPointHighlightBlacklist: (request: AddPointHighlightBlacklistRequest) => Promise<void>;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void;
  onOpenEditor: (messageId: number) => void;
  onSaveMessageUpdate: (
    messageId: number,
    updater: (message: InboxMessage) => InboxMessage,
  ) => Promise<boolean>;
  onToggleMessageBookmark: (messageId: number, currentlyBookmarked: boolean) => void;
  onToggleMessageImportant: (messageId: number, currentlyImportant: boolean) => void;
  onToggleMessageTag: (messageId: number, tagId: number) => void;
  onAddFrequencyToFilter: (freq: string) => void;
  profiles: Record<string, SignalProfileEntry | null>;
  referenceTimeMs: number | null;
  tagsMap: Record<number, Tag>;
  tagsOrder: number[];
  tagsLoading: boolean;
  tagsLayout: TagsLayoutVariant;
  mediaSummaryEnabled?: boolean;
  messageTextPreviewLines: 20 | 40 | null;
  showCallsignAddForm: boolean;
  searchText?: string | null;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
};

const AnalysisMessageCardItem = memo(function AnalysisMessageCardItem({
  authUserName,
  currentUserLogin,
  copiedFeedbackId,
  botTagAction,
  groupInfos,
  id,
  message,
  messageComments,
  networkDisplayMap,
  onCreateReport,
  onEditReport,
  onCopyFeedback,
  onDeleteOpen,
  onOpenPointsOnMap,
  onAddPointHighlightBlacklist,
  onCancelBotTagAction,
  onMarkBotTagWrong,
  onOpenEditor,
  onSaveMessageUpdate,
  onToggleMessageBookmark,
  onToggleMessageImportant,
  onToggleMessageTag,
  onAddFrequencyToFilter,
  profiles,
  referenceTimeMs,
  tagsMap,
  tagsOrder,
  tagsLoading,
  tagsLayout,
  mediaSummaryEnabled = true,
  messageTextPreviewLines,
  showCallsignAddForm,
  searchText,
  callsignInfoMap,
  networks,
  unitsMap,
}: AnalysisMessageCardItemProps) {
  const normalizeCallsign = (value: string) => value.trim().toUpperCase();
  const saveCallsignPatch = (updater: (message: InboxMessage) => InboxMessage) => {
    return onSaveMessageUpdate(id, updater);
  };
  const etalonDisplayModel = resolveMessageCardEtalonDisplayModel(message, {
    networkDisplayMap,
    networks,
  });
  const labels = buildMessageCardDisplayLabels(message, { groupInfos, profiles });
  const visibleMessageComments = filterOtherMessageComments(currentUserLogin, messageComments);

  return (
    <AnalysisMessageCard
      id={id}
      msg={message}
      referenceTimeMs={referenceTimeMs}
      authUserName={authUserName}
      groupName={labels.groupName}
      reportGroupInfos={groupInfos}
      senderName={labels.senderName}
      copiedFeedbackId={copiedFeedbackId}
      messageComments={visibleMessageComments}
      networkDisplayMap={networkDisplayMap}
      tagsMap={tagsMap}
      tagsOrder={tagsOrder}
      tagsLoading={tagsLoading}
      tagsLayout={tagsLayout}
      messageTextPreviewLines={messageTextPreviewLines}
      searchText={searchText}
      onOpenPointsOnMap={onOpenPointsOnMap}
      onAddPointHighlightBlacklist={onAddPointHighlightBlacklist}
      callsignInfoMap={callsignInfoMap}
      networks={networks}
      unitsMap={unitsMap}
      onBookmark={() => onToggleMessageBookmark(id, message.bookmarked)}
      onImportant={() => onToggleMessageImportant(id, message.important)}
      onCopyText={() => {
        void copyMessageValue(message.text).then(() => {
          onCopyFeedback(`text-${id}`);
        });
      }}
      onCopyFreq={() => {
        void copyMessageValue(message.freq).then(() => {
          onCopyFeedback(`freq-${id}`);
        });
      }}
      onCopyMessageLink={() => {
        void copyMessageValue(buildMessageLinkFullUrl(message, 'analysis', id)).then(() => {
          onCopyFeedback(`link-${id}`);
        });
      }}
      onCopyTextWithNetwork={
        etalonDisplayModel.primaryKind === 'network' && etalonDisplayModel.copyEtalonValue != null
          ? () => {
              void copyMessageValue(
                buildCopyTextWithNetworkName(
                  message.text,
                  etalonDisplayModel.copyEtalonValue,
                  message.noHeadersBody,
                ),
              ).then(() => {
                onCopyFeedback(`text-network-${id}`);
              });
            }
          : undefined
      }
      onCopyTextWithNetworkAndNote={
        etalonDisplayModel.primaryKind === 'network' &&
        etalonDisplayModel.copyEtalonValue != null &&
        isPresent(message.extendedForm) &&
        message.extendedForm.trim() !== ''
          ? () => {
              void copyMessageValue(
                buildCopyTextWithNetworkAndNote(
                  message.text,
                  etalonDisplayModel.copyEtalonValue,
                  message.extendedForm,
                  message.noHeadersBody,
                ),
              ).then(() => {
                onCopyFeedback(`text-network-note-${id}`);
              });
            }
          : undefined
      }
      onCopyEtalon={
        etalonDisplayModel.copyEtalonValue == null
          ? undefined
          : () => {
              void copyMessageValue(etalonDisplayModel.copyEtalonValue).then(() => {
                onCopyFeedback(`etalon-${id}`);
              });
            }
      }
      onCopyLocation={
        etalonDisplayModel.copyLocationValue == null
          ? undefined
          : () => {
              void copyMessageValue(etalonDisplayModel.copyLocationValue).then(() => {
                onCopyFeedback(`location-${id}`);
              });
            }
      }
      onAddFrequencyToFilter={onAddFrequencyToFilter}
      onCreateReport={() => onCreateReport(id)}
      onEditReport={onEditReport}
      onDelete={() => onDeleteOpen(id)}
      onEditDetails={() => onOpenEditor(id)}
      onToggleTag={(tagId) => onToggleMessageTag(id, tagId)}
      botTagAction={botTagAction?.messageId === id ? botTagAction : null}
      onCancelBotTagAction={onCancelBotTagAction}
      onMarkBotTagWrong={onMarkBotTagWrong}
      analysisCallsignActions={{
        onAddCallsign: async (callsign) => {
          return saveCallsignPatch((current) => {
            const currentCallsigns = current.callsigns ?? [];
            const nextCallsign = normalizeCallsign(callsign);
            if (currentCallsigns.some((item) => normalizeCallsign(item) === nextCallsign))
              return current;
            return { ...current, callsigns: [...currentCallsigns, nextCallsign] };
          });
        },
        onRemoveCallsign: async (callsign) => {
          return saveCallsignPatch((current) => ({
            ...current,
            callsigns: (current.callsigns ?? []).filter(
              (item) => normalizeCallsign(item) !== normalizeCallsign(callsign),
            ),
          }));
        },
      }}
      showCallsignAddForm={showCallsignAddForm}
      mediaSummaryEnabled={mediaSummaryEnabled}
    />
  );
});

function AnalysisMessagesPaneComponent({
  authUserName,
  currentUser,
  copiedFeedbackId: copiedFeedbackIdProp,
  botTagAction,
  groupInfos,
  paginationLoading,
  messageComments,
  messages,
  networkDisplayMap,
  pageIndex,
  pageNavigationTarget,
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
  onAddFrequencyToFilter,
  profiles,
  tagsMap,
  tagsOrder,
  tagsLoading,
  tagsLayout,
  mediaSummaryEnabled = true,
  messageTextPreviewLines,
  showCallsignAddForm,
  searchText,
  callsignInfoMap,
  networks,
  unitsMap,
  directMessageNavigation,
}: Props) {
  const theme = useTheme();
  const [copiedFeedbackId, setCopiedFeedbackId] = useState<string | null>(copiedFeedbackIdProp);
  const [deleteMessageId, setDeleteMessageId] = useState<number | null>(null);
  const [bottomAnchorSpacerPx, setBottomAnchorSpacerPx] = useState(0);
  const [autoLoadCheckVersion, setAutoLoadCheckVersion] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const referenceTimeMsRef = useRef<number | null>(Date.now());
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const preserveScrollOnPageChangeRef = useRef(false);
  const paginationRequestInFlightRef = useRef(false);
  const focusedRequestsInFlightRef = useRef(new Map<'earlier' | 'later', number>());
  const initialFocusedLoadTargetIdRef = useRef<number | null>(null);
  const targetAnchorCenterRef = useRef<number | null>(null);
  const centeredTargetIdRef = useRef<number | null>(null);
  const preserveTargetAnchorRef = useRef(false);
  const clearTargetHighlightRef = useRef<(() => void) | null>(null);
  const currentUserLogin = authUserName?.trim() || currentUser?.name?.trim() || null;

  const updateVisiblePageIndex = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container == null || messages.length === 0) return;
    const messageElements = container.querySelectorAll<HTMLElement>('[data-message-id]');
    if (messageElements.length === 0) return;

    const containerTop = container.getBoundingClientRect().top + container.clientTop;
    let firstVisibleMessageIndex = messageElements.length - 1;
    for (let index = 0; index < messageElements.length; index += 1) {
      if (messageElements[index].getBoundingClientRect().bottom > containerTop) {
        firstVisibleMessageIndex = index;
        break;
      }
    }

    const firstLoadedPageIndex = getFirstLoadedMessagesPageIndex(pageIndex, messages.length);
    onVisiblePageChange(
      Math.min(
        pageIndex,
        firstLoadedPageIndex + Math.floor(firstVisibleMessageIndex / ANALYSIS_MESSAGES_PAGE_SIZE),
      ),
    );
  }, [messages.length, onVisiblePageChange, pageIndex]);

  useEffect(() => {
    setCopiedFeedbackId(copiedFeedbackIdProp);
  }, [copiedFeedbackIdProp]);

  useEffect(() => {
    referenceTimeMsRef.current = Date.now();
  }, [messages]);

  useEffect(() => {
    if (preserveScrollOnPageChangeRef.current) {
      preserveScrollOnPageChangeRef.current = false;
      return;
    }
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [pageIndex]);

  useEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
  }, [scrollResetKey]);

  const handleLoadMoreMessages = useCallback(async () => {
    if (paginationRequestInFlightRef.current || paginationLoading || noMoreToLoad) {
      return;
    }
    paginationRequestInFlightRef.current = true;
    preserveScrollOnPageChangeRef.current = true;
    let loaded = false;
    try {
      loaded = await onLoadMoreMessages();
      if (!loaded) preserveScrollOnPageChangeRef.current = false;
    } catch (error) {
      preserveScrollOnPageChangeRef.current = false;
      throw error;
    } finally {
      paginationRequestInFlightRef.current = false;
      if (loaded) setAutoLoadCheckVersion((current) => current + 1);
    }
  }, [noMoreToLoad, onLoadMoreMessages, paginationLoading]);

  useEffect(() => {
    return () => {
      if (isPresent(copyFeedbackTimerRef.current)) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
      clearTargetHighlightRef.current?.();
    };
  }, []);

  const highlightedTargetIdRef = useRef<number | null>(null);

  const getTargetElement = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container == null || directMessageNavigation == null) return null;
    return container.querySelector<HTMLElement>(
      `[data-message-id="${directMessageNavigation.targetMessageId}"]`,
    );
  }, [directMessageNavigation?.targetMessageId]);

  const captureTargetAnchor = useCallback(() => {
    const targetElement = getTargetElement();
    if (targetElement != null) {
      targetAnchorCenterRef.current = getElementVerticalCenter(getTargetCardElement(targetElement));
    }
  }, [getTargetElement]);

  const restoreTargetAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    const targetElement = getTargetElement();
    if (container == null || targetElement == null || targetAnchorCenterRef.current == null) return;
    const offset =
      getElementVerticalCenter(getTargetCardElement(targetElement)) - targetAnchorCenterRef.current;
    if (Math.abs(offset) < 0.5) return;
    container.scrollTop += offset;
  }, [getTargetElement]);

  const centerTarget = useCallback(() => {
    const container = scrollContainerRef.current;
    const targetElement = getTargetElement();
    if (
      container == null ||
      targetElement == null ||
      directMessageNavigation == null ||
      !directMessageNavigation.focusActive
    ) {
      return;
    }
    const centeredTarget = getContainerVerticalCenter(container);
    if (centeredTarget == null) return;
    centeredTargetIdRef.current = directMessageNavigation.targetMessageId;
    targetAnchorCenterRef.current = centeredTarget;
    preserveTargetAnchorRef.current = true;
    restoreTargetAnchor();
  }, [directMessageNavigation, getTargetElement, restoreTargetAnchor]);

  const beginTargetAnchorRestoration = useCallback(
    (position: MessageLoadPosition) => {
      centerTarget();
      preserveTargetAnchorRef.current = true;
      if (position !== 'above') return;
      const container = scrollContainerRef.current;
      if (container == null) return;
      const missingContentBelow = getMissingBottomScrollSpace(container);
      setBottomAnchorSpacerPx((current) => Math.max(current, Math.ceil(missingContentBelow)));
    },
    [centerTarget],
  );

  const handleFocusedLoad = useCallback(
    async (position: MessageLoadPosition) => {
      if (directMessageNavigation == null || directMessageNavigation.contextLoading) return false;
      const direction = getFocusedLoadDirection(position, directMessageNavigation.newestFirst);
      const loading =
        direction === 'earlier'
          ? directMessageNavigation.loadingEarlier
          : directMessageNavigation.loadingLater;
      const targetMessageId = directMessageNavigation.targetMessageId;
      if (focusedRequestsInFlightRef.current.get(direction) === targetMessageId || loading) {
        return false;
      }
      const canLoad =
        direction === 'earlier'
          ? directMessageNavigation.canLoadEarlier
          : directMessageNavigation.canLoadLater;
      if (!canLoad) return false;

      focusedRequestsInFlightRef.current.set(direction, targetMessageId);
      beginTargetAnchorRestoration(position);
      let loaded = false;
      try {
        const load =
          direction === 'earlier'
            ? directMessageNavigation.onLoadEarlier
            : directMessageNavigation.onLoadLater;
        loaded = await load();
      } finally {
        if (focusedRequestsInFlightRef.current.get(direction) === targetMessageId) {
          focusedRequestsInFlightRef.current.delete(direction);
        }
        if (loaded) setAutoLoadCheckVersion((current) => current + 1);
      }
      return loaded;
    },
    [beginTargetAnchorRestoration, directMessageNavigation],
  );

  const loadMessagesNearScrollBoundary = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container == null || messages.length === 0) return;

    if (directMessageNavigation != null) {
      if (directMessageNavigation.contextLoading) return;
      if (initialFocusedLoadTargetIdRef.current !== directMessageNavigation.targetMessageId) return;
      for (const position of ['above', 'below'] as const) {
        const direction = getFocusedLoadDirection(position, directMessageNavigation.newestFirst);
        const directionLoading =
          direction === 'earlier'
            ? directMessageNavigation.loadingEarlier
            : directMessageNavigation.loadingLater;
        const canLoad =
          direction === 'earlier'
            ? directMessageNavigation.canLoadEarlier
            : directMessageNavigation.canLoadLater;
        if (!directionLoading && canLoad && isNearMessageLoadPosition(container, position)) {
          void handleFocusedLoad(position);
        }
      }
      return;
    }

    if (!noMoreToLoad && !paginationLoading && isNearMessageLoadPosition(container, 'below')) {
      void handleLoadMoreMessages();
    }
  }, [
    directMessageNavigation,
    handleFocusedLoad,
    handleLoadMoreMessages,
    messages.length,
    noMoreToLoad,
    paginationLoading,
  ]);

  useEffect(() => {
    if (directMessageNavigation == null) {
      initialFocusedLoadTargetIdRef.current = null;
      return;
    }
    const targetMessageId = directMessageNavigation.targetMessageId;
    if (initialFocusedLoadTargetIdRef.current === targetMessageId) return;
    focusedRequestsInFlightRef.current.clear();
    initialFocusedLoadTargetIdRef.current = targetMessageId;
  }, [directMessageNavigation]);

  const reconcileBottomAnchorSpacer = useCallback(() => {
    setBottomAnchorSpacerPx((current) => {
      if (current === 0) return current;
      const container = scrollContainerRef.current;
      if (container == null) return current;
      return Math.ceil(getMissingBottomScrollSpace(container));
    });
  }, []);

  useLayoutEffect(() => {
    if (directMessageNavigation == null || !directMessageNavigation.focusActive) {
      targetAnchorCenterRef.current = null;
      centeredTargetIdRef.current = null;
      preserveTargetAnchorRef.current = false;
      return;
    }
    const targetElement = getTargetElement();
    if (targetElement == null) return;
    if (centeredTargetIdRef.current !== directMessageNavigation.targetMessageId) {
      centerTarget();
      return;
    }
    restoreTargetAnchor();
  }, [
    bottomAnchorSpacerPx,
    directMessageNavigation?.canLoadEarlier,
    directMessageNavigation?.canLoadLater,
    directMessageNavigation?.contextLoading,
    directMessageNavigation?.focusActive,
    directMessageNavigation?.loadingEarlier,
    directMessageNavigation?.loadingLater,
    directMessageNavigation?.newestFirst,
    centerTarget,
    getTargetElement,
    messages,
    restoreTargetAnchor,
  ]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const messageList = container?.querySelector('ul');
    if (
      directMessageNavigation == null ||
      !directMessageNavigation.focusActive ||
      container == null ||
      messageList == null ||
      typeof ResizeObserver === 'undefined'
    ) {
      return;
    }
    const observer = new ResizeObserver(() => {
      centerTarget();
      if (preserveTargetAnchorRef.current) restoreTargetAnchor();
    });
    observer.observe(container);
    observer.observe(messageList);
    for (const messageElement of messageList.children) observer.observe(messageElement);
    return () => observer.disconnect();
  }, [centerTarget, directMessageNavigation, messages, restoreTargetAnchor]);

  useLayoutEffect(() => {
    if (directMessageNavigation == null) {
      setBottomAnchorSpacerPx(0);
      return;
    }
    reconcileBottomAnchorSpacer();
  }, [directMessageNavigation, messages, reconcileBottomAnchorSpacer]);

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
    const targetElement = getTargetElement();
    if (targetElement) {
      clearTargetHighlightRef.current?.();
      highlightedTargetIdRef.current = directMessageNavigation.targetMessageId;
      clearTargetHighlightRef.current = scrollToAndHighlightMessage(targetElement, {
        scroll: false,
        persistentHighlight: true,
      });
    }
  }, [directMessageNavigation, getTargetElement, messages]);

  const handleScroll = useCallback(() => {
    updateVisiblePageIndex();
    reconcileBottomAnchorSpacer();
    if (!preserveTargetAnchorRef.current) captureTargetAnchor();
    loadMessagesNearScrollBoundary();
  }, [
    captureTargetAnchor,
    loadMessagesNearScrollBoundary,
    reconcileBottomAnchorSpacer,
    updateVisiblePageIndex,
  ]);

  useLayoutEffect(() => {
    updateVisiblePageIndex();
  }, [updateVisiblePageIndex]);

  useLayoutEffect(() => {
    if (pageNavigationTarget == null) return;
    const container = scrollContainerRef.current;
    if (container == null) return;
    const firstLoadedPageIndex = getFirstLoadedMessagesPageIndex(pageIndex, messages.length);
    const messageIndex =
      (pageNavigationTarget - firstLoadedPageIndex) * ANALYSIS_MESSAGES_PAGE_SIZE;
    const messageElement =
      container.querySelectorAll<HTMLElement>('[data-message-id]')[messageIndex];
    if (messageElement != null) {
      const containerTop = container.getBoundingClientRect().top + container.clientTop;
      container.scrollTop += messageElement.getBoundingClientRect().top - containerTop;
      onVisiblePageChange(pageNavigationTarget);
    }
    onPageNavigationHandled();
  }, [
    messages.length,
    onPageNavigationHandled,
    onVisiblePageChange,
    pageIndex,
    pageNavigationTarget,
  ]);

  useLayoutEffect(() => {
    loadMessagesNearScrollBoundary();
  }, [autoLoadCheckVersion, loadMessagesNearScrollBoundary, messages]);

  const clearFocusOnScrollStart = useCallback(() => {
    preserveTargetAnchorRef.current = false;
    if (directMessageNavigation?.focusActive) directMessageNavigation.onClearFocus();
  }, [directMessageNavigation]);

  const showCopiedFeedback = useCallback((value: string) => {
    if (isPresent(copyFeedbackTimerRef.current)) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    setCopiedFeedbackId(value);
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopiedFeedbackId((current) => (current === value ? null : current));
      copyFeedbackTimerRef.current = null;
    }, 1000);
  }, []);

  const handleDeleteOpen = useCallback(
    (messageId: number) => {
      blurActiveElement();
      setDeleteMessageId(messageId);
    },
    [blurActiveElement],
  );

  const handleOpenEditor = useCallback(
    (messageId: number) => {
      blurActiveElement();
      onOpenEditor(messageId);
    },
    [blurActiveElement, onOpenEditor],
  );

  const isFocusedPositionLoading = (position: MessageLoadPosition) => {
    if (directMessageNavigation == null) return false;
    const direction = getFocusedLoadDirection(position, directMessageNavigation.newestFirst);
    const loadingDirection =
      direction === 'earlier'
        ? directMessageNavigation.loadingEarlier
        : directMessageNavigation.loadingLater;
    return loadingDirection;
  };
  const focusedLoadingAbove = isFocusedPositionLoading('above');
  const focusedLoadingBelow = isFocusedPositionLoading('below');
  const displayedMessages = directMessageNavigation?.contextLoading
    ? messages.filter(([messageId]) => messageId === directMessageNavigation.targetMessageId)
    : messages;

  if (messages.length === 0) {
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
      <Box
        ref={scrollContainerRef}
        tabIndex={directMessageNavigation?.focusActive ? 0 : undefined}
        onScroll={handleScroll}
        onWheel={clearFocusOnScrollStart}
        onTouchMove={clearFocusOnScrollStart}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) clearFocusOnScrollStart();
        }}
        onKeyDown={(event) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
            clearFocusOnScrollStart();
          }
        }}
        sx={{
          ...getAnalysisMessagesScrollSx(theme),
          overflowY: 'auto',
          overflowAnchor: 'none',
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
        }}
      >
        <Box
          component="ul"
          sx={{
            m: 0,
            p: 0,
            listStyle: 'none',
            width: '100%',
            maxWidth: '100%',
            minWidth: 0,
            '& > li': {
              width: '100%',
              maxWidth: '100%',
              minWidth: 0,
            },
          }}
        >
          {focusedLoadingAbove || directMessageNavigation?.contextLoading ? (
            <MessageLoadingSkeletons position="above" />
          ) : null}
          {displayedMessages.map(([id, message]) => (
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
              onAddFrequencyToFilter={onAddFrequencyToFilter}
              profiles={profiles}
              referenceTimeMs={referenceTimeMsRef.current}
              tagsMap={tagsMap}
              tagsOrder={tagsOrder}
              tagsLoading={tagsLoading}
              tagsLayout={tagsLayout}
              mediaSummaryEnabled={mediaSummaryEnabled}
              messageTextPreviewLines={messageTextPreviewLines}
              showCallsignAddForm={showCallsignAddForm}
              searchText={searchText}
              callsignInfoMap={callsignInfoMap}
              networks={networks}
              unitsMap={unitsMap}
            />
          ))}
          {focusedLoadingBelow ||
          directMessageNavigation?.contextLoading ||
          (directMessageNavigation == null && paginationLoading) ? (
            <MessageLoadingSkeletons position="below" />
          ) : null}
        </Box>
        {directMessageNavigation != null && bottomAnchorSpacerPx > 0 ? (
          <Box
            aria-hidden="true"
            data-direct-message-anchor-spacer="true"
            style={{ height: bottomAnchorSpacerPx }}
          />
        ) : null}
      </Box>

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
