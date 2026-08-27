import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  CircularProgress,
  ListItemText,
  Menu,
  MenuItem,
} from '@mui/material';
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
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
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

function NarrowMessagesLoadingIndicator({
  loading,
  paginationLoading,
}: {
  loading: boolean;
  paginationLoading: boolean;
}) {
  if (!loading && !paginationLoading) return null;
  const label = loading ? 'Оновлення повідомлень' : 'Завантаження ще повідомлень';

  return (
    <Box
      sx={{
        display: { xs: 'block', lg: 'none' },
        position: 'sticky',
        top: 0,
        height: 0,
        overflow: 'visible',
        zIndex: 3,
        pointerEvents: 'none',
      }}
    >
      <Box
        role="status"
        aria-live="polite"
        aria-label={label}
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
          bgcolor: 'background.paper',
        }}
      >
        <CircularProgress size={16} />
        {label}
      </Box>
    </Box>
  );
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
  loading: boolean;
  paginationLoading: boolean;
  messageComments: Record<number, MessageComment[]>;
  messages: Array<[number, InboxMessage]>;
  networkDisplayMap: Record<number, string>;
  pageIndex: number;
  scrollResetKey: string;
  noMoreToLoad: boolean;
  onDeleteMessage: (messageId: number) => void;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void;
  onOpenEditor: (messageId: number) => void;
  onCreateReport: (messageId: number) => void;
  onEditReport: (messageId: number) => void | Promise<void>;
  onLoadMoreMessages: () => Promise<boolean>;
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

function FocusedLoadMoreButton({
  position,
  navigation,
  onBeforeLoad,
}: {
  position: 'above' | 'below';
  navigation: AnalysisDirectMessageNavigation;
  onBeforeLoad: (position: 'above' | 'below') => void;
}) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const direction =
    position === 'above'
      ? navigation.newestFirst
        ? 'later'
        : 'earlier'
      : navigation.newestFirst
        ? 'earlier'
        : 'later';
  const canLoad = direction === 'earlier' ? navigation.canLoadEarlier : navigation.canLoadLater;
  const load = direction === 'earlier' ? navigation.onLoadEarlier : navigation.onLoadLater;
  if (!canLoad) return null;

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', my: 1 }}>
      <ButtonGroup size="small" variant="outlined" aria-label="Показати ще повідомлення">
        <Button
          onClick={() => {
            onBeforeLoad(position);
            void load();
          }}
          disabled={navigation.loadingDirection !== null}
          sx={{ minHeight: 28, px: 1, py: 0.25, fontSize: '0.75rem' }}
        >
          Показати ще
        </Button>
        {navigation.filterOptions.length > 0 ? (
          <Button
            aria-label="Опції фільтра для показу повідомлень"
            aria-haspopup="menu"
            aria-expanded={menuAnchor == null ? undefined : 'true'}
            onClick={(event) => setMenuAnchor(event.currentTarget)}
            disabled={navigation.loadingDirection !== null}
            sx={{ minWidth: 28, px: 0.25 }}
          >
            <ArrowDropDownIcon />
          </Button>
        ) : null}
      </ButtonGroup>
      <Menu anchorEl={menuAnchor} open={menuAnchor != null} onClose={() => setMenuAnchor(null)}>
        {navigation.filterOptions.map((option) => (
          <MenuItem
            key={`${option.kind}:${option.value}`}
            onClick={() => navigation.onToggleFilter(option)}
          >
            <Checkbox checked={option.selected} />
            <ListItemText primary={option.label} />
          </MenuItem>
        ))}
      </Menu>
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
  loading,
  paginationLoading,
  messageComments,
  messages,
  networkDisplayMap,
  pageIndex,
  scrollResetKey,
  noMoreToLoad,
  onDeleteMessage,
  onCancelBotTagAction,
  onMarkBotTagWrong,
  onOpenEditor,
  onCreateReport,
  onEditReport,
  onLoadMoreMessages,
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
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const referenceTimeMsRef = useRef<number | null>(Date.now());
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const preserveScrollOnPageChangeRef = useRef(false);
  const targetAnchorTopRef = useRef<number | null>(null);
  const preserveTargetAnchorRef = useRef(false);
  const currentUserLogin = authUserName?.trim() || currentUser?.name?.trim() || null;

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
    preserveScrollOnPageChangeRef.current = true;
    try {
      const loaded = await onLoadMoreMessages();
      if (!loaded) preserveScrollOnPageChangeRef.current = false;
    } catch (error) {
      preserveScrollOnPageChangeRef.current = false;
      throw error;
    }
  }, [onLoadMoreMessages]);

  useEffect(() => {
    return () => {
      if (isPresent(copyFeedbackTimerRef.current)) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
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
    if (targetElement != null)
      targetAnchorTopRef.current = targetElement.getBoundingClientRect().top;
  }, [getTargetElement]);

  const restoreTargetAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    const targetElement = getTargetElement();
    if (container == null || targetElement == null || targetAnchorTopRef.current == null) return;
    const offset = targetElement.getBoundingClientRect().top - targetAnchorTopRef.current;
    if (Math.abs(offset) < 0.5) return;
    container.scrollTop += offset;
  }, [getTargetElement]);

  const beginTargetAnchorRestoration = useCallback(
    (position: 'above' | 'below') => {
      captureTargetAnchor();
      preserveTargetAnchorRef.current = true;
      if (position !== 'above') return;
      const container = scrollContainerRef.current;
      if (container == null) return;
      const missingContentBelow = getMissingBottomScrollSpace(container);
      setBottomAnchorSpacerPx((current) => Math.max(current, Math.ceil(missingContentBelow)));
    },
    [captureTargetAnchor],
  );

  const reconcileBottomAnchorSpacer = useCallback(() => {
    setBottomAnchorSpacerPx((current) => {
      if (current === 0) return current;
      const container = scrollContainerRef.current;
      if (container == null) return current;
      return Math.ceil(getMissingBottomScrollSpace(container));
    });
  }, []);

  useLayoutEffect(() => {
    if (directMessageNavigation == null) {
      targetAnchorTopRef.current = null;
      preserveTargetAnchorRef.current = false;
      return;
    }
    const targetElement = getTargetElement();
    if (targetElement == null) return;
    if (targetAnchorTopRef.current == null) {
      targetAnchorTopRef.current = targetElement.getBoundingClientRect().top;
      return;
    }
    restoreTargetAnchor();
  }, [
    bottomAnchorSpacerPx,
    directMessageNavigation?.canLoadEarlier,
    directMessageNavigation?.canLoadLater,
    directMessageNavigation?.newestFirst,
    getTargetElement,
    messages,
    restoreTargetAnchor,
  ]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    const messageList = container?.querySelector('ul');
    if (
      directMessageNavigation == null ||
      messageList == null ||
      typeof ResizeObserver === 'undefined'
    ) {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (preserveTargetAnchorRef.current) restoreTargetAnchor();
    });
    observer.observe(messageList);
    for (const messageElement of messageList.children) observer.observe(messageElement);
    return () => observer.disconnect();
  }, [directMessageNavigation, messages, restoreTargetAnchor]);

  useLayoutEffect(() => {
    if (directMessageNavigation == null) {
      setBottomAnchorSpacerPx(0);
      return;
    }
    reconcileBottomAnchorSpacer();
  }, [directMessageNavigation, messages, reconcileBottomAnchorSpacer]);

  useEffect(() => {
    if (
      directMessageNavigation == null ||
      !directMessageNavigation.focusActive ||
      highlightedTargetIdRef.current === directMessageNavigation.targetMessageId ||
      loading ||
      messages.length === 0
    ) {
      return;
    }
    const targetElement = getTargetElement();
    if (targetElement) {
      highlightedTargetIdRef.current = directMessageNavigation.targetMessageId;
      scrollToAndHighlightMessage(targetElement, { scroll: false });
      captureTargetAnchor();
    }
  }, [captureTargetAnchor, directMessageNavigation, getTargetElement, loading, messages]);

  const handleScroll = useCallback(() => {
    reconcileBottomAnchorSpacer();
    if (!preserveTargetAnchorRef.current) captureTargetAnchor();
  }, [captureTargetAnchor, reconcileBottomAnchorSpacer]);

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

  if (messages.length === 0 && !loading) {
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
          overflowAnchor: 'none',
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
        }}
      >
        <NarrowMessagesLoadingIndicator loading={loading} paginationLoading={paginationLoading} />
        {directMessageNavigation ? (
          <FocusedLoadMoreButton
            position="above"
            navigation={directMessageNavigation}
            onBeforeLoad={beginTargetAnchorRestoration}
          />
        ) : null}
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
          {messages.map(([id, message]) => (
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
        </Box>
        {directMessageNavigation ? (
          <FocusedLoadMoreButton
            position="below"
            navigation={directMessageNavigation}
            onBeforeLoad={beginTargetAnchorRestoration}
          />
        ) : !noMoreToLoad && messages.length > 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2, mb: 2 }}>
            <Button
              variant="outlined"
              onClick={() => void handleLoadMoreMessages()}
              disabled={loading || paginationLoading}
            >
              Завантажити ще
            </Button>
          </Box>
        ) : null}
        {directMessageNavigation != null && bottomAnchorSpacerPx > 0 ? (
          <Box
            aria-hidden="true"
            data-direct-message-anchor-spacer="true"
            style={{ height: bottomAnchorSpacerPx }}
          />
        ) : null}
      </Box>

      {loading ? (
        <SectionLoadingOverlay
          open
          ariaLabel="Оновлення повідомлень"
          sx={{ zIndex: 2, display: { xs: 'none', lg: 'flex' } }}
        />
      ) : null}
      {paginationLoading ? (
        <SectionLoadingOverlay
          open
          ariaLabel="Завантаження ще повідомлень"
          sx={{ zIndex: 2, display: { xs: 'none', lg: 'flex' } }}
        />
      ) : null}

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
