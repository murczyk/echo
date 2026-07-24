import type {
  CallsignInfoRes,
  InboxMessage,
  MessageComment,
  Network,
  Tag,
  Unit,
} from '../../../../../Bindings';
import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
import ChatBubbleOutlineOutlinedIcon from '@mui/icons-material/ChatBubbleOutlineOutlined';
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
import { MessageCardCoordinatePreview } from './MessageCardCoordinatePreview';
import { hasCoordinatePreviewCandidate } from './message-coordinate-preview';
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
import { PowerAlert } from '../../../components/PowerAlert';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { listPalitras } from '../../../services/api/palitra';
import type { Palitra } from '../../../../../Bindings';
import {
  pointBlacklistLabelKey,
  type AddPointHighlightBlacklistRequest,
  type PointBlacklistRequestSource,
} from './point-highlight-blacklist';

type PointBlacklistDialogState = {
  request: AddPointHighlightBlacklistRequest;
  palitraIds: number[];
};

function PointBlacklistPaletteDialog({
  state,
  palitras,
  loading,
  error,
  pendingPalitraIds,
  mutationError,
  onRetry,
  onChoose,
  onClose,
}: {
  state: PointBlacklistDialogState | null;
  palitras: Palitra[];
  loading: boolean;
  error: string | null;
  pendingPalitraIds: Set<number>;
  mutationError: string | null;
  onRetry: () => void;
  onChoose: (palitraId: number) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={state != null} onClose={onClose} disableRestoreFocus>
      <DialogTitle>Додати до чорного списку</DialogTitle>
      <DialogContent>
        {state ? (
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            Точка: {state.request.etalon}
          </Typography>
        ) : null}
        {loading ? <CircularProgress size={24} aria-label="Завантаження палітр" /> : null}
        {error ? (
          <PowerAlert
            severity="warning"
            autoHideDuration={null}
            action={<Button onClick={onRetry}>Повторити</Button>}
          >
            {error}
          </PowerAlert>
        ) : null}
        {state ? (
          <List disablePadding>
            {state.palitraIds.map((palitraId) => {
              const palitra = palitras.find((entry) => entry.id === palitraId);
              return (
                <ListItemButton
                  key={palitraId}
                  disabled={palitraId <= 0 || pendingPalitraIds.has(palitraId)}
                  onClick={() => onChoose(palitraId)}
                >
                  {pendingPalitraIds.has(palitraId) ? (
                    <CircularProgress size={18} sx={{ mr: 1 }} />
                  ) : null}
                  <ListItemText primary={palitra?.name?.trim() || `Палітра #${palitraId}`} />
                </ListItemButton>
              );
            })}
          </List>
        ) : null}
        {mutationError ? (
          <PowerAlert severity="error" autoHideDuration={null}>
            {mutationError}
          </PowerAlert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Закрити</Button>
      </DialogActions>
    </Dialog>
  );
}

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
  onAddPointHighlightBlacklist,
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
  onAddPointHighlightBlacklist?: (request: AddPointHighlightBlacklistRequest) => Promise<void>;
}) {
  const { notify } = useOptionalPowerSnackbar();
  const images = collectMessageImages(msg);
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
  const [imagePreviewIndex, setImagePreviewIndex] = useState<number | null>(null);
  const [videoPreviewIndex, setVideoPreviewIndex] = useState<number | null>(null);
  const [pointBlacklistDialog, setPointBlacklistDialog] =
    useState<PointBlacklistDialogState | null>(null);
  const [pointBlacklistPalitras, setPointBlacklistPalitras] = useState<Palitra[]>([]);
  const [pointBlacklistLoading, setPointBlacklistLoading] = useState(false);
  const [pointBlacklistLoadError, setPointBlacklistLoadError] = useState<string | null>(null);
  const [pointBlacklistPendingPalitraIds, setPointBlacklistPendingPalitraIds] = useState<
    Set<number>
  >(new Set());
  const [pointBlacklistPendingKeys, setPointBlacklistPendingKeys] = useState<Set<string>>(
    new Set(),
  );
  const [pointBlacklistMutationError, setPointBlacklistMutationError] = useState<string | null>(
    null,
  );
  const pointBlacklistPalitrasPromiseRef = useRef<Promise<Palitra[]> | null>(null);
  const pointBlacklistPendingKeysRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadPointBlacklistPalitras = useCallback(() => {
    if (pointBlacklistPalitrasPromiseRef.current) return;
    setPointBlacklistLoading(true);
    setPointBlacklistLoadError(null);
    const promise = listPalitras();
    pointBlacklistPalitrasPromiseRef.current = promise;
    promise
      .then((palitras) => {
        if (!mountedRef.current) return;
        setPointBlacklistPalitras(palitras);
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) return;
        setPointBlacklistLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (mountedRef.current) setPointBlacklistLoading(false);
      });
  }, []);

  const requestPointBlacklist = useCallback(
    (source: PointBlacklistRequestSource) => {
      const palitraIds = Array.from(new Set(source.palitraIds));
      if (!onAddPointHighlightBlacklist || palitraIds.length === 0) return;
      if (palitraIds.length > 1) {
        setPointBlacklistMutationError(null);
        setPointBlacklistDialog({
          request: { messageId: source.messageId, etalon: source.etalon, palitraId: palitraIds[0] },
          palitraIds,
        });
        loadPointBlacklistPalitras();
        return;
      }

      const request = {
        messageId: source.messageId,
        etalon: source.etalon,
        palitraId: palitraIds[0],
      };
      const key = `${request.messageId}:${pointBlacklistLabelKey(request.etalon)}:${request.palitraId}`;
      if (pointBlacklistPendingKeysRef.current.has(key)) return;
      pointBlacklistPendingKeysRef.current.add(key);
      setPointBlacklistPendingKeys((current) => new Set(current).add(key));
      setPointBlacklistMutationError(null);
      void onAddPointHighlightBlacklist(request)
        .then(() => {
          notify({ severity: 'success', message: 'Точку додано до чорного списку.' });
        })
        .catch((error: unknown) => {
          notify({
            severity: 'error',
            message: `Не вдалося додати точку до чорного списку: ${error instanceof Error ? error.message : String(error)}`,
          });
        })
        .finally(() => {
          pointBlacklistPendingKeysRef.current.delete(key);
          if (mountedRef.current) {
            setPointBlacklistPendingKeys((current) => {
              const next = new Set(current);
              next.delete(key);
              return next;
            });
          }
        });
    },
    [loadPointBlacklistPalitras, notify, onAddPointHighlightBlacklist],
  );

  const choosePointBlacklistPalitra = useCallback(
    async (palitraId: number) => {
      if (!pointBlacklistDialog || !onAddPointHighlightBlacklist || palitraId <= 0) return;
      const request = { ...pointBlacklistDialog.request, palitraId };
      const key = `${request.messageId}:${pointBlacklistLabelKey(request.etalon)}:${request.palitraId}`;
      if (pointBlacklistPendingKeysRef.current.has(key)) return;
      pointBlacklistPendingKeysRef.current.add(key);
      setPointBlacklistPendingPalitraIds((current) => new Set(current).add(palitraId));
      setPointBlacklistMutationError(null);
      try {
        await onAddPointHighlightBlacklist(request);
        if (mountedRef.current) {
          setPointBlacklistDialog(null);
          notify({ severity: 'success', message: 'Точку додано до чорного списку.' });
        }
      } catch (error: unknown) {
        if (mountedRef.current) {
          const message = error instanceof Error ? error.message : String(error);
          setPointBlacklistMutationError(`Не вдалося додати точку до чорного списку: ${message}`);
          notify({
            severity: 'error',
            message: `Не вдалося додати точку до чорного списку: ${message}`,
          });
        }
      } finally {
        pointBlacklistPendingKeysRef.current.delete(key);
        if (mountedRef.current) {
          setPointBlacklistPendingPalitraIds((current) => {
            const next = new Set(current);
            next.delete(palitraId);
            return next;
          });
        }
      }
    },
    [notify, onAddPointHighlightBlacklist, pointBlacklistDialog],
  );

  const retryPointBlacklistPalitras = useCallback(() => {
    pointBlacklistPalitrasPromiseRef.current = null;
    loadPointBlacklistPalitras();
  }, [loadPointBlacklistPalitras]);

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

  const showPointLinks = messageHasPalitraTag(msg, tagsMap);
  const hasTags = tagsLayout !== 'hidden' && Object.keys(tagsMap).length > 0;
  const textPrimary = useMemoText(
    msg,
    messageId,
    tagsMap,
    showPointLinks,
    callsignInfoMap,
    networks,
    unitsMap,
    searchText,
    onOpenPointsOnMap,
    requestPointBlacklist,
    pointBlacklistPendingKeys,
  );
  const hasTextPrimary = Array.isArray(textPrimary)
    ? textPrimary.some((node) => isPresent(node))
    : isPresent(textPrimary);

  return (
    <div className="flex flex-col min-w-0" style={{ gap: compact ? '12px' : '10px' }}>
      <PointBlacklistPaletteDialog
        state={pointBlacklistDialog}
        palitras={pointBlacklistPalitras}
        loading={pointBlacklistLoading}
        error={pointBlacklistLoadError}
        pendingPalitraIds={pointBlacklistPendingPalitraIds}
        mutationError={pointBlacklistMutationError}
        onRetry={retryPointBlacklistPalitras}
        onChoose={choosePointBlacklistPalitra}
        onClose={() => {
          setPointBlacklistDialog(null);
          setPointBlacklistPendingPalitraIds(new Set());
          setPointBlacklistMutationError(null);
        }}
      />
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
          isDownloadStarting={isDownloadStarting}
          onDownloadStart={onDownloadStart}
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
                        setDocumentPreviewIndex(previewIndex);
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
      {videoPreviewIndex !== null ? (
        <MessageCardVideoPreviewDialog
          open={true}
          onClose={() => setVideoPreviewIndex(null)}
          videos={videoPreviewSources}
          currentIndex={videoPreviewIndex ?? 0}
          onIndexChange={(idx) => setVideoPreviewIndex(idx)}
          isDownloadStarting={isDownloadStarting}
          onDownloadStart={onDownloadStart}
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
  messageId: number,
  tagsMap: Record<number, Tag>,
  showPointLinks: boolean,
  callsignInfoMap?: Record<string, CallsignInfoRes>,
  networks?: Network[],
  unitsMap?: Record<number, Unit>,
  searchText?: string | null,
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void,
  onRequestPointBlacklist?: (source: PointBlacklistRequestSource) => void,
  pendingBlacklistKeys?: Set<string>,
) {
  return msg.textMarked && msg.textMarked.length > 0
    ? renderMarkedText(msg.textMarked, msg.text ?? '', getPointEtalonsFromMessage(msg, tagsMap), {
        showPointLinks,
        message: msg,
        onOpenPointsOnMap,
        messageId,
        onRequestPointBlacklist,
        pendingBlacklistKeys,
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
