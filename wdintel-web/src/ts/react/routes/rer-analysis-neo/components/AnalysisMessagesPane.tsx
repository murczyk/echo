import { Box, Button } from '@mui/material';
import { CircularProgress } from '@mui/material';
import { alpha, type Theme, useTheme } from '@mui/material/styles';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
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
import { DeleteConfirmDialog, CommentDialog } from '../../rer-duty-neo/dialogs';
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
import { AnalysisMessageCard } from '../../shared/message-card/MessageCard';
import {
  resolveMessageCardEtalonDisplayModel,
  buildCopyTextWithNetworkAndNote,
  buildCopyTextWithNetworkName,
} from '../../shared/message-card/message-card.utils';
import { buildMessageCardDisplayLabels } from '../../shared/message-card/message-card-labels';
import { blurActiveElement } from '../../../utils/focus';
import { copyMessageValue } from '../message-utils';
import { PowerAlert } from '../../../components/PowerAlert';
import type { TagsLayoutVariant } from '../../rer-duty-neo/utils';

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
  onDeleteMessage: (messageId: number) => void;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void;
  onOpenEditor: (messageId: number) => void;
  onOpenPointsOnMap: (etalons: string[], message: InboxMessage) => void;
  onSaveMessageUpdate: (
    messageId: number,
    updater: (message: InboxMessage) => InboxMessage,
  ) => Promise<boolean>;
  onSaveMessageComment: (messageId: number, comment: string | null) => void;
  onToggleMessageBookmark: (messageId: number, currentlyBookmarked: boolean) => void;
  onToggleMessageImportant: (messageId: number, currentlyImportant: boolean) => void;
  onToggleMessageTag: (messageId: number, tagId: number) => void;
  onAddFrequencyToFilter: (freq: string) => void;
  profiles: Record<string, SignalProfileEntry | null>;
  tagsMap: Record<number, Tag>;
  tagsOrder: number[];
  tagsLoading: boolean;
  tagsLayout: TagsLayoutVariant;
  searchText?: string | null;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
};

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
  onCommentOpen: (id: number, message: InboxMessage) => void;
  onCopyFeedback: (value: string) => void;
  onDeleteOpen: (messageId: number) => void;
  onOpenPointsOnMap: (etalons: string[], message: InboxMessage) => void;
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
  onCommentOpen,
  onCopyFeedback,
  onDeleteOpen,
  onOpenPointsOnMap,
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
      senderName={labels.senderName}
      copiedFeedbackId={copiedFeedbackId}
      messageComments={visibleMessageComments}
      networkDisplayMap={networkDisplayMap}
      tagsMap={tagsMap}
      tagsOrder={tagsOrder}
      tagsLoading={tagsLoading}
      tagsLayout={tagsLayout}
      searchText={searchText}
      onOpenPointsOnMap={onOpenPointsOnMap}
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
      onComment={() => onCommentOpen(id, message)}
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
        onAddSuggestedCallsign: async (callsign) => {
          return saveCallsignPatch((current) => {
            const currentCallsigns = current.callsigns ?? [];
            const nextCallsign = normalizeCallsign(callsign);
            if (currentCallsigns.some((item) => normalizeCallsign(item) === nextCallsign))
              return current;
            return { ...current, callsigns: [...currentCallsigns, nextCallsign] };
          });
        },
      }}
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
  onDeleteMessage,
  onCancelBotTagAction,
  onMarkBotTagWrong,
  onOpenEditor,
  onOpenPointsOnMap,
  onSaveMessageUpdate,
  onSaveMessageComment,
  onToggleMessageBookmark,
  onToggleMessageImportant,
  onToggleMessageTag,
  onAddFrequencyToFilter,
  profiles,
  tagsMap,
  tagsOrder,
  tagsLoading,
  tagsLayout,
  searchText,
  callsignInfoMap,
  networks,
  unitsMap,
}: Props) {
  const theme = useTheme();
  const [commentDraft, setCommentDraft] = useState('');
  const [commentMessage, setCommentMessage] = useState<{
    id: number;
    message: InboxMessage;
  } | null>(null);
  const [copiedFeedbackId, setCopiedFeedbackId] = useState<string | null>(copiedFeedbackIdProp);
  const [deleteMessageId, setDeleteMessageId] = useState<number | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const referenceTimeMsRef = useRef<number | null>(Date.now());
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const currentUserLogin = authUserName?.trim() || currentUser?.name?.trim() || null;

  useEffect(() => {
    setCopiedFeedbackId(copiedFeedbackIdProp);
  }, [copiedFeedbackIdProp]);

  useEffect(() => {
    referenceTimeMsRef.current = Date.now();
  }, [messages]);

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }
  }, [pageIndex]);

  useEffect(() => {
    return () => {
      if (isPresent(copyFeedbackTimerRef.current)) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
    };
  }, []);

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

  const handleCommentOpen = useCallback(
    (messageId: number, nextMessage: InboxMessage) => {
      blurActiveElement();
      setCommentMessage({ id: messageId, message: nextMessage });
      setCommentDraft(nextMessage.extendedForm ?? '');
    },
    [blurActiveElement],
  );

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
        sx={{
          ...getAnalysisMessagesScrollSx(theme),
          width: '100%',
          maxWidth: '100%',
          minWidth: 0,
        }}
      >
        <NarrowMessagesLoadingIndicator loading={loading} paginationLoading={paginationLoading} />
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
              onCommentOpen={handleCommentOpen}
              onCopyFeedback={showCopiedFeedback}
              onDeleteOpen={handleDeleteOpen}
              onOpenPointsOnMap={onOpenPointsOnMap}
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
              searchText={searchText}
              callsignInfoMap={callsignInfoMap}
              networks={networks}
              unitsMap={unitsMap}
            />
          ))}
        </Box>
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

      <CommentDialog
        open={isPresent(commentMessage)}
        messagePreview={
          commentMessage
            ? buildMessageCardDisplayLabels(commentMessage.message, { groupInfos, profiles })
                .commentPreview
            : null
        }
        commentText={commentDraft}
        onCommentTextChange={setCommentDraft}
        onClose={() => setCommentMessage(null)}
        onSave={() => {
          if (!commentMessage) return;
          onSaveMessageComment(commentMessage.id, commentDraft.trim() || null);
          setCommentMessage(null);
        }}
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
