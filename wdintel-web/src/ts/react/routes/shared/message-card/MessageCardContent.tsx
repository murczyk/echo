import type {
  CallsignInfoRes,
  ContentNode,
  InboxMessage,
  MessageComment,
  Network,
  Tag,
  Unit,
} from '../../../../../Bindings';
import { Button, CircularProgress, Typography } from '@mui/material';
import ChatBubbleOutlineOutlinedIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { MessageCardCoordinateAttachment } from './MessageCardCoordinateAttachment';
import {
  hasCoordinatePreviewCandidate,
  type CoordinatePreviewPoint,
} from './message-coordinate-preview';
import {
  isAudioMediaAttachment,
  canDownloadAllMessageAttachments,
  isVideoMediaAttachment,
  mediaAttachmentContentType,
  mediaAttachmentDisplayName,
  MessageMediaAudioPlayer,
  MessageMediaDownloadAllLink,
  MessageMediaDownloadLink,
  MESSAGE_CARD_DOWNLOAD_START_COOLDOWN_MS,
} from './MessageCardMedia';
import { collectMessageImages } from './message-card-image-utils';
import { MessageCardImageList } from './MessageCardImageList';
import { MessageCardTags } from './MessageCardTags';
import type { AnalysisCallsignActions, MessageCardBotTagAction } from './message-card.types';
import { MessageMediaDocumentLink } from './MessageMediaDocumentLink';
import { collectMessageDocuments } from './message-card-document-utils';
import { blurActiveElement } from '../../../utils/focus';
import {
  MessageCardAttachmentPreviewProvider,
  type MessageCardPreviewAttachment,
} from './attachment-preview/MessageCardAttachmentPreviewProvider';

export type { AnalysisCallsignActions, MessageCardBotTagAction } from './message-card.types';

const MESSAGE_TEXT_PREVIEW_LINE_LIMIT = 20;

function hasMoreThanPreviewLineLimit(messageText: string): boolean {
  return messageText.split(/\r?\n/).length > MESSAGE_TEXT_PREVIEW_LINE_LIMIT;
}

function previewTextRows(messageText: string): string {
  return messageText.split(/\r?\n/).slice(0, MESSAGE_TEXT_PREVIEW_LINE_LIMIT).join('\n');
}

function previewMarkedTextRows(nodes: ContentNode[]): ContentNode[] {
  const previewNodes: ContentNode[] = [];
  let renderedLineBreaks = 0;

  for (const node of nodes) {
    if (node === 'CNNewlineC') {
      if (renderedLineBreaks === MESSAGE_TEXT_PREVIEW_LINE_LIMIT - 1) break;
      renderedLineBreaks += 1;
    }
    previewNodes.push(node);
  }

  return previewNodes;
}

export function MessageCardMessageBody({
  compact = false,
  messageId,
  msg,
  tagsMap,
  tagsOrder,
  tagContributionsOrganismId,
  tagsLoading = false,
  onToggleTag,
  readOnly = false,
  tagsLayout = 'full',
  botTagAction = null,
  onCancelBotTagAction,
  onMarkBotTagWrong,
  analysisCallsignActions,
  showCallsignAddForm = false,
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
  tagContributionsOrganismId?: number;
  tagsLoading?: boolean;
  readOnly?: boolean;
  onToggleTag?: (tagId: number) => void;
  tagsLayout?: TagsLayoutVariant;
  botTagAction?: MessageCardBotTagAction | null;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void | Promise<void>;
  analysisCallsignActions?: AnalysisCallsignActions;
  showCallsignAddForm?: boolean;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
  messageComments?: MessageComment[];
  signalMessageSenderLabel?: string | null;
  searchText?: string | null;
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
}) {
  const images = collectMessageImages(msg);
  const messageText = msg.text ?? '';
  const hasMessageTextOverflow = hasMoreThanPreviewLineLimit(messageText);
  const [isMessageTextExpanded, setIsMessageTextExpanded] = useState(false);
  const [activeDownloadKeys, setActiveDownloadKeys] = useState<Set<string>>(() => new Set());
  const activeDownloadKeysRef = useRef<Set<string>>(new Set());
  const downloadCooldownTimersRef = useRef<Map<string, number>>(new Map());
  const isDownloadStarting = useCallback(
    (downloadKey: string) =>
      activeDownloadKeys.has(downloadKey) || activeDownloadKeysRef.current.has(downloadKey),
    [activeDownloadKeys],
  );
  const onDownloadStart = useCallback((downloadKey: string) => {
    if (activeDownloadKeysRef.current.has(downloadKey)) return false;
    const nextActiveDownloadKeys = new Set(activeDownloadKeysRef.current);
    nextActiveDownloadKeys.add(downloadKey);
    activeDownloadKeysRef.current = nextActiveDownloadKeys;
    setActiveDownloadKeys(nextActiveDownloadKeys);
    const timer = window.setTimeout(() => {
      const activeKeys = new Set(activeDownloadKeysRef.current);
      activeKeys.delete(downloadKey);
      activeDownloadKeysRef.current = activeKeys;
      setActiveDownloadKeys(activeKeys);
      downloadCooldownTimersRef.current.delete(downloadKey);
    }, MESSAGE_CARD_DOWNLOAD_START_COOLDOWN_MS);
    downloadCooldownTimersRef.current.set(downloadKey, timer);
    return true;
  }, []);
  useEffect(() => {
    return () => {
      for (const timer of downloadCooldownTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      downloadCooldownTimersRef.current.clear();
    };
  }, []);
  useEffect(() => {
    setIsMessageTextExpanded(false);
  }, [messageText]);
  const [attachmentPreviewIndex, setAttachmentPreviewIndex] = useState<number | null>(null);
  const [coordinatePreviewPoints, setCoordinatePreviewPoints] = useState<CoordinatePreviewPoint[]>(
    [],
  );

  const imageHrefSet = useMemo(() => new Set(images.map((image) => image.href)), [images]);
  const documents = collectMessageDocuments(msg);
  const previewableDocuments = documents.filter((document) => document.kind !== 'unsupported');
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
  const canDownloadAllAttachments = canDownloadAllMessageAttachments(msg.media ?? []);
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
  const previewAttachments = useMemo<MessageCardPreviewAttachment[]>(
    () => [
      ...images.map((image) => ({ type: 'image' as const, value: image })),
      ...videoPreviewSources.map((video) => ({ type: 'video' as const, value: video })),
      ...previewableDocuments.map((document) => ({
        type: 'document' as const,
        value: document,
      })),
      ...coordinatePreviewPoints.map((point) => ({
        type: 'coordinate' as const,
        value: point,
        points: coordinatePreviewPoints,
      })),
    ],
    [coordinatePreviewPoints, images, previewableDocuments, videoPreviewSources],
  );
  const coordinatePreviewStartIndex =
    images.length + videoPreviewSources.length + previewableDocuments.length;

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
    hasMessageTextOverflow && !isMessageTextExpanded,
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
            setAttachmentPreviewIndex(index);
          }}
          onOpenVideo={(index) => {
            blurActiveElement();
            setAttachmentPreviewIndex(images.length + index);
          }}
        />
      ) : null}
      {attachmentPreviewIndex != null && previewAttachments.length > 0 ? (
        <MessageCardAttachmentPreviewProvider
          attachments={previewAttachments}
          initialIndex={attachmentPreviewIndex}
          onClose={() => setAttachmentPreviewIndex(null)}
          isDownloadStarting={isDownloadStarting}
          onDownloadStart={onDownloadStart}
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
                        setAttachmentPreviewIndex(
                          images.length + videoAttachments.length + previewIndex,
                        );
                      }
                    : undefined
                }
                isDownloadStarting={isDownloadStarting}
                onDownloadStart={onDownloadStart}
              />
            );
          })}
          {downloadAttachments.map((attachment) => (
            <MessageMediaDownloadLink
              key={attachment.id}
              attachment={attachment}
              isDownloadStarting={isDownloadStarting}
              onDownloadStart={onDownloadStart}
            />
          ))}
        </div>
      ) : null}
      {canDownloadAllAttachments ? (
        <div className="mt-1 flex items-start w-full">
          <MessageMediaDownloadAllLink
            messageId={messageId}
            isDownloadStarting={isDownloadStarting}
            onDownloadStart={onDownloadStart}
          />
        </div>
      ) : null}
      {hasTextPrimary || hasMessageTextOverflow ? (
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
          {hasMessageTextOverflow ? (
            <Button
              size="small"
              color="inherit"
              variant="text"
              onClick={() => setIsMessageTextExpanded((value) => !value)}
              aria-expanded={isMessageTextExpanded}
              aria-label={
                isMessageTextExpanded
                  ? 'Згорнути текст повідомлення'
                  : 'Показати текст повідомлення'
              }
              endIcon={
                isMessageTextExpanded ? (
                  <ExpandLessIcon fontSize="inherit" aria-hidden />
                ) : (
                  <ExpandMoreIcon fontSize="inherit" aria-hidden />
                )
              }
              sx={{
                display: 'flex',
                width: 'fit-content',
                flexShrink: 0,
                minHeight: 27,
                py: 0,
                px: 0.5,
                mt: 0.5,
                fontSize: '0.875rem',
                fontWeight: 400,
                textTransform: 'none',
                color: 'var(--color-action)',
                '& .MuiButton-endIcon': { ml: 1, mr: 0, '& i': { fontSize: '0.875rem' } },
                alignSelf: 'flex-start',
              }}
            >
              {isMessageTextExpanded ? 'Згорнути' : 'Показати більше'}
            </Button>
          ) : null}
        </div>
      ) : null}
      {hasCoordinatePreviewCandidate(msg, tagsMap) ? (
        <MessageCardCoordinateAttachment
          msg={msg}
          tagsMap={tagsMap}
          onPointsChange={setCoordinatePreviewPoints}
          onOpen={(index) => {
            blurActiveElement();
            setAttachmentPreviewIndex(coordinatePreviewStartIndex + index);
          }}
        />
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
              tagContributionsOrganismId={tagContributionsOrganismId}
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
          showAddForm={showCallsignAddForm}
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
  showTextPreview = false,
) {
  const messageText = msg.text ?? '';
  const visibleText = showTextPreview ? previewTextRows(messageText) : messageText;
  return msg.textMarked && msg.textMarked.length > 0
    ? renderMarkedText(
        showTextPreview ? previewMarkedTextRows(msg.textMarked) : msg.textMarked,
        visibleText,
        getPointEtalonsFromMessage(msg, tagsMap),
        {
          showPointLinks,
          message: msg,
          onOpenPointsOnMap,
          callsignInfoMap,
          networks,
          unitsMap,
          freq: msg.freq ?? null,
          networkIds: msg.networkIds ?? null,
          searchText,
        },
      )
    : (() => {
        const text = visibleText.trim();
        if (text === '' || text === '—' || text === '-') return null;
        return renderLinkifiedText(visibleText);
      })();
}

// Repeated card-content path: avoid structural MUI wrappers and per-card layout sx.
// Preserve MUI theme parity through semantic styles; see ./AGENTS.md.
export const MessageCardContent = memo(MessageCardMessageBody);
