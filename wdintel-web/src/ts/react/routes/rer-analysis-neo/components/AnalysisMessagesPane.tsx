import { Alert, Box, Button } from '@mui/material';
import { useEffect, useState } from 'react';

import type { InboxMessage, SignalGroupEntry, SignalProfileEntry, Tag } from '../../../../../Bindings';
import { DeleteConfirmDialog, CommentDialog } from '../../rer-duty-neo/dialogs';
import { MessageCard } from '../../rer-duty-neo/MessageCard';
import { AnalysisMessageEditDrawer } from './AnalysisMessageEditDrawer';
import { buildSenderLabel, copyMessageValue } from '../message-utils';

type Props = {
  authUserName: string | null;
  copiedFeedbackId: string | null;
  groupInfos: Record<string, SignalGroupEntry>;
  loading: boolean;
  messages: Array<[number, InboxMessage]>;
  networkDisplayMap: Record<number, string>;
  noMoreToLoad: boolean;
  editorMessage: { id: number; message: InboxMessage } | null;
  editorSaveInFlight: boolean;
  onCloseEditor: () => void;
  onDeleteMessage: (messageId: number) => void;
  onLoadMoreMessages: () => void;
  onOpenEditor: (messageId: number) => void;
  onSaveEditor: () => void;
  onSaveMessageComment: (messageId: number, comment: string | null) => void;
  onToggleMessageBookmark: (messageId: number, currentlyBookmarked: boolean) => void;
  onToggleMessageImportant: (messageId: number, currentlyImportant: boolean) => void;
  onToggleMessageTag: (messageId: number, tagId: number) => void;
  onUpdateEditorField: <K extends keyof InboxMessage>(field: K, value: InboxMessage[K]) => void;
  profiles: Record<string, SignalProfileEntry | null>;
  tagsMap: Record<number, Tag>;
};

export function AnalysisMessagesPane({
  authUserName,
  copiedFeedbackId: copiedFeedbackIdProp,
  editorMessage,
  editorSaveInFlight,
  groupInfos,
  loading,
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
  onUpdateEditorField,
  profiles,
  tagsMap,
}: Props) {
  const [commentDraft, setCommentDraft] = useState('');
  const [commentMessage, setCommentMessage] = useState<{ id: number; message: InboxMessage } | null>(null);
  const [copiedFeedbackId, setCopiedFeedbackId] = useState<string | null>(copiedFeedbackIdProp);
  const [deleteMessageId, setDeleteMessageId] = useState<number | null>(null);

  useEffect(() => {
    setCopiedFeedbackId(copiedFeedbackIdProp);
  }, [copiedFeedbackIdProp]);

  if (messages.length === 0 && !loading) {
    return <Alert severity="info">Немає жодного повідомлення для аналізу.</Alert>;
  }

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0 }}>
      <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
        {messages.map(([id, message]) => (
          <MessageCard
            key={id}
            id={id}
            msg={message}
            feedId="analysis"
            layoutVariant="dividers"
            referenceTimeMs={Date.now()}
            authUserName={authUserName}
            groupName={message.groupMasterKey ? groupInfos[message.groupMasterKey]?.name ?? message.groupMasterKey : null}
            senderName={buildSenderLabel(message.sender ? profiles[message.sender] : null, message.sender)}
            copiedFeedbackId={copiedFeedbackId}
            networkDisplayMap={networkDisplayMap}
            tagsMap={tagsMap}
            onBookmark={() => onToggleMessageBookmark(id, message.bookmarked)}
            onImportant={() => onToggleMessageImportant(id, message.important)}
            onCopyText={() => {
              void copyMessageValue(message.text).then(() => {
                setCopiedFeedbackId(`text-${id}`);
                window.setTimeout(() => {
                  setCopiedFeedbackId((current) => (current === `text-${id}` ? null : current));
                }, 1000);
              });
            }}
            onCopyFreq={() => {
              void copyMessageValue(message.freq).then(() => {
                setCopiedFeedbackId(`freq-${id}`);
                window.setTimeout(() => {
                  setCopiedFeedbackId((current) => (current === `freq-${id}` ? null : current));
                }, 1000);
              });
            }}
            onComment={() => {
              setCommentMessage({ id, message });
              setCommentDraft(message.extendedForm ?? '');
            }}
            onDelete={() => setDeleteMessageId(id)}
            onEditDetails={() => onOpenEditor(id)}
            onToggleTag={(tagId) => onToggleMessageTag(id, tagId)}
          />
        ))}
      </Box>
      {!noMoreToLoad && messages.length > 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button variant="outlined" onClick={onLoadMoreMessages} disabled={loading}>
            Завантажити ще
          </Button>
        </Box>
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
        onUpdateField={onUpdateEditorField}
      />
    </Box>
  );
}
