import { Alert, Box, Button } from '@mui/material';
import { memo, useCallback, useEffect, useRef, useState } from 'react';

import type { CallsignInfoRes, InboxMessage, Network, SignalGroupEntry, SignalProfileEntry, Tag, Unit } from '../../../../../Bindings';
import { DeleteConfirmDialog, CommentDialog } from '../../rer-duty-neo/dialogs';
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
import { MessageCard } from '../../rer-duty-neo/MessageCard';
import { AnalysisMessageEditDrawer } from './AnalysisMessageEditDrawer';
import { buildSenderLabel, copyMessageValue } from '../message-utils';

type Props = {
  authUserName: string | null;
  copiedFeedbackId: string | null;
  groupInfos: Record<string, SignalGroupEntry>;
  loading: boolean;
  paginationLoading: boolean;
  messages: Array<[number, InboxMessage]>;
  networkDisplayMap: Record<number, string>;
  noMoreToLoad: boolean;
  editorMessage: { id: number; message: InboxMessage } | null;
  editorSaveInFlight: boolean;
  onCloseEditor: () => void;
  onDeleteMessage: (messageId: number) => void;
  onLoadMoreMessages: () => void;
  onOpenEditor: (messageId: number) => void;
  onSaveEditor: (message: InboxMessage) => void;
  onSaveMessageComment: (messageId: number, comment: string | null) => void;
  onToggleMessageBookmark: (messageId: number, currentlyBookmarked: boolean) => void;
  onToggleMessageImportant: (messageId: number, currentlyImportant: boolean) => void;
  onToggleMessageTag: (messageId: number, tagId: number) => void;
  profiles: Record<string, SignalProfileEntry | null>;
  tagsMap: Record<number, Tag>;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
};

type AnalysisMessageCardItemProps = {
  authUserName: string | null;
  copiedFeedbackId: string | null;
  groupInfos: Record<string, SignalGroupEntry>;
  id: number;
  message: InboxMessage;
  networkDisplayMap: Record<number, string>;
  onCommentOpen: (id: number, message: InboxMessage) => void;
  onCopyFeedback: (value: string) => void;
  onDeleteOpen: (messageId: number) => void;
  onOpenEditor: (messageId: number) => void;
  onToggleMessageBookmark: (messageId: number, currentlyBookmarked: boolean) => void;
  onToggleMessageImportant: (messageId: number, currentlyImportant: boolean) => void;
  onToggleMessageTag: (messageId: number, tagId: number) => void;
  profiles: Record<string, SignalProfileEntry | null>;
  referenceTimeMs: number | null;
  tagsMap: Record<number, Tag>;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
};

const AnalysisMessageCardItem = memo(function AnalysisMessageCardItem({
  authUserName,
  copiedFeedbackId,
  groupInfos,
  id,
  message,
  networkDisplayMap,
  onCommentOpen,
  onCopyFeedback,
  onDeleteOpen,
  onOpenEditor,
  onToggleMessageBookmark,
  onToggleMessageImportant,
  onToggleMessageTag,
  profiles,
  referenceTimeMs,
  tagsMap,
  callsignInfoMap,
  networks,
  unitsMap,
}: AnalysisMessageCardItemProps) {
  return (
    <MessageCard
      id={id}
      msg={message}
      displayMode="analysis"
      referenceTimeMs={referenceTimeMs}
      authUserName={authUserName}
      groupName={message.groupMasterKey ? groupInfos[message.groupMasterKey]?.name ?? message.groupMasterKey : null}
      senderName={buildSenderLabel(message.sender ? profiles[message.sender] : null, message.sender)}
      copiedFeedbackId={copiedFeedbackId}
      networkDisplayMap={networkDisplayMap}
      tagsMap={tagsMap}
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
      onComment={() => onCommentOpen(id, message)}
      onDelete={() => onDeleteOpen(id)}
      onEditDetails={() => onOpenEditor(id)}
      onToggleTag={(tagId) => onToggleMessageTag(id, tagId)}
    />
  );
});

function AnalysisMessagesPaneComponent({
  authUserName,
  copiedFeedbackId: copiedFeedbackIdProp,
  editorMessage,
  editorSaveInFlight,
  groupInfos,
  loading,
  paginationLoading,
  messages,
  networkDisplayMap,
  noMoreToLoad,
  onCloseEditor,
  onDeleteMessage,
  onLoadMoreMessages,
  onOpenEditor,
  onSaveEditor,
  onSaveMessageComment,
  onToggleMessageBookmark,
  onToggleMessageImportant,
  onToggleMessageTag,
  profiles,
  tagsMap,
  callsignInfoMap,
  networks,
  unitsMap,
}: Props) {
  const [commentDraft, setCommentDraft] = useState('');
  const [commentMessage, setCommentMessage] = useState<{ id: number; message: InboxMessage } | null>(null);
  const [copiedFeedbackId, setCopiedFeedbackId] = useState<string | null>(copiedFeedbackIdProp);
  const [deleteMessageId, setDeleteMessageId] = useState<number | null>(null);
  const referenceTimeMsRef = useRef<number | null>(Date.now());
  const copyFeedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setCopiedFeedbackId(copiedFeedbackIdProp);
  }, [copiedFeedbackIdProp]);

  useEffect(() => {
    referenceTimeMsRef.current = Date.now();
  }, [messages]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current != null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
    };
  }, []);

  const showCopiedFeedback = useCallback((value: string) => {
    if (copyFeedbackTimerRef.current != null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    setCopiedFeedbackId(value);
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      setCopiedFeedbackId((current) => (current === value ? null : current));
      copyFeedbackTimerRef.current = null;
    }, 1000);
  }, []);

  const handleCommentOpen = useCallback((messageId: number, nextMessage: InboxMessage) => {
    setCommentMessage({ id: messageId, message: nextMessage });
    setCommentDraft(nextMessage.extendedForm ?? '');
  }, []);

  if (messages.length === 0 && !loading) {
    return <Alert severity="info">Немає жодного повідомлення для аналізу.</Alert>;
  }

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden', px: 0, position: 'relative' }}>
      <Box sx={{ height: '100%', overflow: 'auto' }}>
        <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {messages.map(([id, message]) => (
            <AnalysisMessageCardItem
              key={id}
              authUserName={authUserName}
              copiedFeedbackId={copiedFeedbackId}
              groupInfos={groupInfos}
              id={id}
              message={message}
              networkDisplayMap={networkDisplayMap}
              onCommentOpen={handleCommentOpen}
              onCopyFeedback={showCopiedFeedback}
              onDeleteOpen={setDeleteMessageId}
              onOpenEditor={onOpenEditor}
              onToggleMessageBookmark={onToggleMessageBookmark}
              onToggleMessageImportant={onToggleMessageImportant}
              onToggleMessageTag={onToggleMessageTag}
              profiles={profiles}
              referenceTimeMs={referenceTimeMsRef.current}
              tagsMap={tagsMap}
              callsignInfoMap={callsignInfoMap}
              networks={networks}
              unitsMap={unitsMap}
            />
          ))}
        </Box>
        {!noMoreToLoad && messages.length > 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
            <Button variant="outlined" onClick={onLoadMoreMessages} disabled={loading || paginationLoading}>
              {paginationLoading ? 'Завантаження...' : 'Завантажити ще'}
            </Button>
          </Box>
        ) : null}
      </Box>

      {loading ? (
        <SectionLoadingOverlay open ariaLabel="Оновлення повідомлень" sx={{ zIndex: 2 }} />
      ) : null}

      <CommentDialog
        open={commentMessage != null}
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
        open={deleteMessageId != null}
        onClose={() => setDeleteMessageId(null)}
        onConfirm={() => {
          if (deleteMessageId == null) return;
          onDeleteMessage(deleteMessageId);
          setDeleteMessageId(null);
        }}
      />

      <AnalysisMessageEditDrawer
        message={editorMessage}
        open={editorMessage != null}
        saveInFlight={editorSaveInFlight}
        onClose={onCloseEditor}
        onSave={onSaveEditor}
      />
    </Box>
  );
}

export const AnalysisMessagesPane = memo(AnalysisMessagesPaneComponent);
