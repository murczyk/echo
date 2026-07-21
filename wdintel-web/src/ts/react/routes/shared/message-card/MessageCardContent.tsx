import type {
  CallsignInfoRes,
  InboxMessage,
  MessageComment,
  Network,
  Tag,
  Unit,
} from '../../../../../Bindings';
import { CircularProgress, Typography } from '@mui/material';
import ChatBubbleOutlineOutlinedIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import { memo, useMemo, useState } from 'react';
import { isPresent } from '../../../utils/misc';
import {
  getPointEtalonsFromMessage,
  messageHasPalitraTag,
  type TagsLayoutVariant,
} from '../../rer-duty-neo/utils';
import { renderMarkedText } from './MarkedText';
import { renderLinkifiedText } from './message-card-linkify';
import { MessageCardBotTagPrompt } from './MessageCardBotTagPrompt';
import { MessageCardComments } from './MessageCardComments';
import { MessageCardCallsignsSection } from './MessageCardCallsignsSection';
import { MessageCardCoordinatePreview } from './MessageCardCoordinatePreview';
import { hasCoordinatePreviewCandidate } from './message-coordinate-preview';
import {
  isAudioMediaAttachment,
  isVideoMediaAttachment,
  mediaAttachmentContentType,
  mediaAttachmentDisplayName,
  MessageMediaAudioPlayer,
  MessageMediaDownloadAllLink,
  MessageMediaDownloadLink,
} from './MessageCardMedia';
import { MessageImagePreviewDialog } from './MessageCardImagePreviewDialog';
import { MessageCardVideoPreviewDialog } from './MessageCardVideoPreviewDialog';
import { collectMessageImages } from './message-card-image-utils';
import { MessageCardImageList } from './MessageCardImageList';
import { MessageCardTags } from './MessageCardTags';
import type { AnalysisCallsignActions, MessageCardBotTagAction } from './message-card.types';
import { MessageMediaDocumentLink } from './MessageMediaDocumentLink';
import { MessageCardDocumentPreviewDialog } from './MessageCardDocumentPreviewDialog';
import { collectMessageDocuments } from './message-card-document-utils';
import { blurActiveElement } from '../../../utils/focus';

export type { AnalysisCallsignActions, MessageCardBotTagAction } from './message-card.types';

export function MessageCardMessageBody({
  compact = false,
  messageId,
  msg,
  tagsMap,
  tagsOrder,
  tagsLoading = false,
  onToggleTag,
  readOnly = false,
  tagsLayout = 'full',
  botTagAction = null,
  onCancelBotTagAction,
  onMarkBotTagWrong,
  analysisCallsignActions,
  callsignInfoMap,
  networks,
  unitsMap,
  messageComments = [],
  signalMessageSenderLabel,
  searchText,
  onOpenPointsOnMap,
}: {
  compact?: boolean;
  messageId: number;
  msg: InboxMessage;
  tagsMap: Record<number, Tag>;
  tagsOrder?: number[];
  tagsLoading?: boolean;
  readOnly?: boolean;
  onToggleTag?: (tagId: number) => void;
  tagsLayout?: TagsLayoutVariant;
  botTagAction?: MessageCardBotTagAction | null;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void | Promise<void>;
  analysisCallsignActions?: AnalysisCallsignActions;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
  messageComments?: MessageComment[];
  signalMessageSenderLabel?: string | null;
  searchText?: string | null;
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
}) {
  const images = collectMessageImages(msg);
  const [imagePreviewIndex, setImagePreviewIndex] = useState<number | null>(null);
  const [videoPreviewIndex, setVideoPreviewIndex] = useState<number | null>(null);

  const imageHrefSet = useMemo(() => new Set(images.map((image) => image.href)), [images]);
  const documents = collectMessageDocuments(msg);
  const previewableDocuments = documents.filter((document) => document.kind !== 'unsupported');
  const [documentPreviewIndex, setDocumentPreviewIndex] = useState<number | null>(null);
  const documentHrefSet = new Set(documents.map((document) => document.href));
  const attachmentMedia = (msg.media ?? []).filter((attachment) => {
    const href = String(attachment.href ?? '');
    if (imageHrefSet.has(href)) return false;
    if (documentHrefSet.has(href)) return false;
    const contentType = mediaAttachmentContentType(attachment);
    if (contentType.startsWith('image/')) return false;
    if (contentType !== '') return true;
    return !/\.(jpe?g|png|gif|webp|bmp|svg)(\?|#|$)/i.test(href);
  });
  const audioAttachments = attachmentMedia.filter(isAudioMediaAttachment);
  const videoAttachments = attachmentMedia.filter(
    (attachment) => isVideoMediaAttachment(attachment) && !isAudioMediaAttachment(attachment),
  );
  const downloadAttachments = attachmentMedia.filter(
    (attachment) => !isAudioMediaAttachment(attachment) && !isVideoMediaAttachment(attachment),
  );
  const hasMultipleAttachments = (msg.media ?? []).length > 1;
  const hasImageOrVideoAttachments = images.length > 0 || videoAttachments.length > 0;

  const videoPreviewSources = useMemo(() => {
    return videoAttachments.map((a) => {
      const raw = a as any;
      return {
        id: a.id ?? '',
        name: mediaAttachmentDisplayName(a),
        source: String(a.href ?? ''),
        mimeType: raw.contentType ?? raw.content_type ?? undefined,
        sizeBytes: raw.sizeBytes ?? raw.size_bytes ?? undefined,
      };
    });
  }, [videoAttachments]);

  const showPointLinks = messageHasPalitraTag(msg, tagsMap);
  const hasTags = tagsLayout !== 'hidden' && Object.keys(tagsMap).length > 0;
  const textPrimary = useMemoText(
    msg,
    tagsMap,
    showPointLinks,
    callsignInfoMap,
    networks,
    unitsMap,
    searchText,
    onOpenPointsOnMap,
  );
  const hasTextPrimary = Array.isArray(textPrimary)
    ? textPrimary.some((node) => isPresent(node))
    : isPresent(textPrimary);

  return (
    <div className="flex flex-col min-w-0" style={{ gap: compact ? '12px' : '10px' }}>
      {hasImageOrVideoAttachments ? (
        <MessageCardImageList
          images={images}
          videos={videoAttachments}
          onOpen={(index) => {
            blurActiveElement();
            setImagePreviewIndex(index);
          }}
          onOpenVideo={(index) => setVideoPreviewIndex(index)}
        />
      ) : null}
      {imagePreviewIndex != null && images.length > 0 ? (
        <MessageImagePreviewDialog
          imageHrefs={images}
          initialIndex={imagePreviewIndex ?? 0}
          currentIndex={imagePreviewIndex ?? 0}
          open={true}
          onClose={() => setImagePreviewIndex(null)}
          onIndexChange={(index) => setImagePreviewIndex(index)}
        />
      ) : null}
      {documentPreviewIndex != null && previewableDocuments.length > 0 ? (
        <MessageCardDocumentPreviewDialog
          documents={previewableDocuments}
          initialIndex={documentPreviewIndex ?? 0}
          currentIndex={documentPreviewIndex ?? 0}
          open={true}
          onClose={() => setDocumentPreviewIndex(null)}
          onIndexChange={(index) => setDocumentPreviewIndex(index)}
        />
      ) : null}
      {audioAttachments.length > 0 ? (
        <div className="mt-1 flex flex-col items-start w-full">
          {audioAttachments.map((attachment) => (
            <MessageMediaAudioPlayer key={attachment.id} attachment={attachment} />
          ))}
        </div>
      ) : null}
      {documents.length > 0 || downloadAttachments.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-start gap-2 w-full">
          {documents.map((document, index) => {
            const previewIndex = previewableDocuments.findIndex(
              (previewableDocument) => previewableDocument.href === document.href,
            );
            return (
              <MessageMediaDocumentLink
                key={document.id ?? document.href}
                document={document}
                index={index}
                onPreview={
                  previewIndex >= 0
                    ? () => {
                        blurActiveElement();
                        setDocumentPreviewIndex(previewIndex);
                      }
                    : undefined
                }
              />
            );
          })}
          {downloadAttachments.map((attachment) => (
            <MessageMediaDownloadLink key={attachment.id} attachment={attachment} />
          ))}
        </div>
      ) : null}
      {hasMultipleAttachments ? (
        <div className="mt-1 flex items-start w-full">
          <MessageMediaDownloadAllLink messageId={messageId} />
        </div>
      ) : null}
      {videoPreviewIndex !== null ? (
        <MessageCardVideoPreviewDialog
          open={true}
          onClose={() => setVideoPreviewIndex(null)}
          videos={videoPreviewSources}
          currentIndex={videoPreviewIndex ?? 0}
          onIndexChange={(idx) => setVideoPreviewIndex(idx)}
        />
      ) : null}
      {hasTextPrimary ? (
        <div
          className={
            msg.textMarked && msg.textMarked.length > 0
              ? 'text-marked whitespace-pre-wrap wrap-break-word'
              : 'whitespace-pre-wrap wrap-break-word'
          }
          style={{
            overflowWrap: 'anywhere',
            lineHeight: 1.35,
          }}
        >
          {textPrimary}
        </div>
      ) : null}
      {hasCoordinatePreviewCandidate(msg, tagsMap) ? (
        <MessageCardCoordinatePreview msg={msg} tagsMap={tagsMap} />
      ) : null}
      {isPresent(msg.extendedForm) && msg.extendedForm.trim() !== '' ? (
        <div className="flex flex-row items-center gap-[6px] min-w-0">
          <ChatBubbleOutlineOutlinedIcon
            sx={{ fontSize: 13, color: 'var(--color-action)', flexShrink: 0 }}
            titleAccess="Коментар"
          />
          <Typography variant="body2" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
            {msg.extendedForm}
          </Typography>
        </div>
      ) : null}
      {messageComments.length > 0 ? (
        <MessageCardComments
          messageComments={messageComments}
          signalMessageSenderLabel={signalMessageSenderLabel}
        />
      ) : null}
      {tagsLoading ? (
        <div className="pt-[2px] min-h-[34px] flex items-center" aria-label="Завантаження тегів">
          <CircularProgress size={14} />
        </div>
      ) : hasTags ? (
        <div className="pt-[2px] min-w-0">
          <span className="inline-flex flex-wrap gap-1 min-w-0 w-full">
            <MessageCardTags
              msg={msg}
              tagsMap={tagsMap}
              tagsOrder={tagsOrder}
              onToggleTag={onToggleTag}
              tagsLayout={tagsLayout}
              interactive={!readOnly && onToggleTag != null}
            />
          </span>
        </div>
      ) : null}
      {!readOnly &&
      botTagAction != null &&
      onMarkBotTagWrong != null &&
      onCancelBotTagAction != null ? (
        <MessageCardBotTagPrompt
          botTagAction={botTagAction}
          onCancelBotTagAction={onCancelBotTagAction}
          onMarkBotTagWrong={onMarkBotTagWrong}
        />
      ) : null}
      {!readOnly && isPresent(analysisCallsignActions) ? (
        <MessageCardCallsignsSection
          msg={msg}
          actions={analysisCallsignActions}
          callsignInfoMap={callsignInfoMap}
        />
      ) : null}
    </div>
  );
}

function useMemoText(
  msg: InboxMessage,
  tagsMap: Record<number, Tag>,
  showPointLinks: boolean,
  callsignInfoMap?: Record<string, CallsignInfoRes>,
  networks?: Network[],
  unitsMap?: Record<number, Unit>,
  searchText?: string | null,
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void,
) {
  return msg.textMarked && msg.textMarked.length > 0
    ? renderMarkedText(msg.textMarked, msg.text ?? '', getPointEtalonsFromMessage(msg, tagsMap), {
        showPointLinks,
        message: msg,
        onOpenPointsOnMap,
        callsignInfoMap,
        networks,
        unitsMap,
        freq: msg.freq ?? null,
        networkIds: msg.networkIds ?? null,
        searchText,
      })
    : (() => {
        const text = msg.text?.trim() ?? '';
        if (text === '' || text === '—' || text === '-') return null;
        return renderLinkifiedText(msg.text);
      })();
}

// Repeated card-content path: avoid structural MUI wrappers and per-card layout sx.
// Preserve MUI theme parity through semantic styles; see ./AGENTS.md.
export const MessageCardContent = memo(MessageCardMessageBody);
