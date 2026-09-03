import type {
  CallsignInfoRes,
  ContentNode,
  InboxMessage,
  MessageComment,
  Network,
  PalitraName,
  SignalGroupEntry,
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
  TextField,
  Typography,
} from '@mui/material';
import { Virtuoso } from 'react-virtuoso';
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
import { DEFAULT_MEDIA_SUMMARY_ENABLED } from '../../../hooks/duty-settings-defaults';
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
import {
  MESSAGE_CARD_AUDIO_REVEAL_ICON,
  MESSAGE_CARD_COORDINATE_REVEAL_ICON,
  MessageCardMediaRevealBanner,
  formatMessageAudioRevealLabel,
  formatMessageVisualRevealLabel,
  messageCardVisualRevealIcon,
} from './MessageCardMediaRevealBanner';
import { blurActiveElement } from '../../../utils/focus';
import { PowerAlert } from '../../../components/PowerAlert';
import { useOptionalPowerSnackbar } from '../../../components/PowerSnackbar';
import { resolvePalitraNames } from '../../../services/api/palitra';
import { usePointBlacklistPaletteNamesCache } from './PointBlacklistPaletteNamesCache';
import {
  MessageCardAttachmentPreviewProvider,
  type MessageCardPreviewAttachment,
} from './attachment-preview/MessageCardAttachmentPreviewProvider';
import { getIntelligenceReports, getParentMessages } from '../intelligence-reports';
import { MessageCardIntelligenceReports } from './MessageCardIntelligenceReports';
import { MessageCardMediaSummaryCarousel } from './attachment-preview/MediaSummaryPreview';
import {
  pointBlacklistLabelKey,
  type AddPointHighlightBlacklistRequest,
  type PointBlacklistRequestSource,
} from './point-highlight-blacklist';

export type { AnalysisCallsignActions, MessageCardBotTagAction } from './message-card.types';

function hasMoreThanPreviewLineLimit(messageText: string, limit: number | null): boolean {
  return limit !== null && messageText.split(/\r?\n/).length > limit;
}

function previewTextRows(messageText: string, limit: number): string {
  return messageText.split(/\r?\n/).slice(0, limit).join('\n');
}

function previewMarkedTextRows(nodes: ContentNode[], limit: number): ContentNode[] {
  const previewNodes: ContentNode[] = [];
  let renderedLineBreaks = 0;

  for (const node of nodes) {
    if (node === 'CNNewlineC') {
      if (renderedLineBreaks === limit - 1) break;
      renderedLineBreaks += 1;
    }
    previewNodes.push(node);
  }

  return previewNodes;
}

type PointBlacklistDialogState = {
  request: AddPointHighlightBlacklistRequest;
  palitraIds: number[];
};

function PointBlacklistPaletteDialog({
  state,
  palitraNames,
  loading,
  error,
  pendingPalitraIds,
  mutationError,
  onRetry,
  onChoose,
  onClose,
}: {
  state: PointBlacklistDialogState;
  palitraNames: PalitraName[];
  loading: boolean;
  error: string | null;
  pendingPalitraIds: Set<number>;
  mutationError: string | null;
  onRetry: () => void;
  onChoose: (palitraId: number) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const searchable = palitraNames.length >= 10;
  const filteredNames = useMemo(
    () =>
      palitraNames.filter((entry) =>
        entry.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
      ),
    [palitraNames, search],
  );
  return (
    <Dialog open onClose={onClose} disableRestoreFocus>
      <DialogTitle>Додати до чорного списку</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          Точка «{state.request.etalon}»
        </Typography>
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
        {!loading && searchable ? (
          <TextField
            label="Пошук палітри"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            fullWidth
            size="small"
            sx={{ mb: 1.5 }}
          />
        ) : null}
        {!loading && palitraNames.length > 50 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Точка знайдена у {palitraNames.length} палітрах. Оберіть палітру або скористайтеся
            пошуком.
          </Typography>
        ) : null}
        {!loading && palitraNames.length === 0 && !error ? (
          <Typography>Жодна доступна палітра для цієї точки не знайдена.</Typography>
        ) : null}
        {!loading && palitraNames.length > 0 && filteredNames.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Палітр за запитом не знайдено.
          </Typography>
        ) : null}
        {!loading && filteredNames.length > 0 && palitraNames.length > 50 ? (
          <Virtuoso
            data={filteredNames}
            style={{ height: 360 }}
            overscan={240}
            itemContent={(_index, { id: palitraId, name }) => {
              const pending = pendingPalitraIds.has(palitraId);
              return (
                <ListItemButton
                  key={palitraId}
                  disabled={pending}
                  onClick={() => onChoose(palitraId)}
                >
                  {pending ? <CircularProgress size={18} sx={{ mr: 1 }} /> : null}
                  <ListItemText primary={name} />
                </ListItemButton>
              );
            }}
          />
        ) : null}
        {!loading && filteredNames.length > 0 && palitraNames.length <= 50 ? (
          <List disablePadding>
            {filteredNames.map(({ id: palitraId, name }) => {
              const pending = pendingPalitraIds.has(palitraId);
              return (
                <ListItemButton
                  key={palitraId}
                  disabled={palitraId <= 0 || pending}
                  onClick={() => onChoose(palitraId)}
                >
                  {pending ? <CircularProgress size={18} sx={{ mr: 1 }} /> : null}
                  <ListItemText primary={name} />
                </ListItemButton>
              );
            })}
          </List>
        ) : null}
        {mutationError ? <PowerAlert severity="error">{mutationError}</PowerAlert> : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Закрити</Button>
      </DialogActions>
    </Dialog>
  );
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
  reportGroupInfos,
  onEditReport,
  signalMessageSenderLabel,
  searchText,
  onOpenPointsOnMap,
  onAddPointHighlightBlacklist,
  collapseMediaPreviews = false,
  mediaSummaryEnabled = DEFAULT_MEDIA_SUMMARY_ENABLED,
  messageTextPreviewLines = 20,
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
  reportGroupInfos: Record<string, SignalGroupEntry>;
  onEditReport?: (reportId: number) => void;
  signalMessageSenderLabel?: string | null;
  searchText?: string | null;
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
  onAddPointHighlightBlacklist?: (request: AddPointHighlightBlacklistRequest) => Promise<void>;
  /** When true, heavy media mounts only after the user opens a reveal banner (Duty default). */
  collapseMediaPreviews?: boolean;
  mediaSummaryEnabled?: boolean;
  messageTextPreviewLines?: 20 | 40 | null;
}) {
  const nameCache = usePointBlacklistPaletteNamesCache();
  const { notify } = useOptionalPowerSnackbar();
  const images = collectMessageImages(msg);
  const messageText = msg.text ?? '';
  const hasMessageTextOverflow = hasMoreThanPreviewLineLimit(messageText, messageTextPreviewLines);
  const [isMessageTextExpanded, setIsMessageTextExpanded] = useState(false);
  const [revealedVisualMedia, setRevealedVisualMedia] = useState(!collapseMediaPreviews);
  const [revealedAudioMedia, setRevealedAudioMedia] = useState(!collapseMediaPreviews);
  const [revealedCoordinateMedia, setRevealedCoordinateMedia] = useState(!collapseMediaPreviews);
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
  }, [messageText, messageTextPreviewLines]);
  useEffect(() => {
    setRevealedVisualMedia(!collapseMediaPreviews);
    setRevealedAudioMedia(!collapseMediaPreviews);
    setRevealedCoordinateMedia(!collapseMediaPreviews);
  }, [collapseMediaPreviews, messageId]);
  const [attachmentPreviewIndex, setAttachmentPreviewIndex] = useState<number | null>(null);
  const [coordinatePreviewPoints, setCoordinatePreviewPoints] = useState<CoordinatePreviewPoint[]>(
    [],
  );
  const [pointBlacklistDialog, setPointBlacklistDialog] =
    useState<PointBlacklistDialogState | null>(null);
  const [pointBlacklistPalitraNames, setPointBlacklistPalitraNames] = useState<PalitraName[]>([]);
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
  const pointBlacklistResolutionGenerationRef = useRef(0);
  const pointBlacklistPendingKeysRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadPointBlacklistPalitraNames = useCallback((palitraIds: number[]) => {
    const generation = ++pointBlacklistResolutionGenerationRef.current;
    const cachedNames = palitraIds
      .map((id) => {
        const name = nameCache?.get(id);
        return name ? { id, name } : null;
      })
      .filter((entry): entry is PalitraName => entry !== null);
    setPointBlacklistPalitraNames(cachedNames);
    setPointBlacklistLoading(true);
    setPointBlacklistLoadError(null);
    const unresolvedIds = palitraIds.filter((id) => !nameCache?.has(id));
    if (unresolvedIds.length === 0) {
      setPointBlacklistLoading(false);
      return;
    }
    resolvePalitraNames(unresolvedIds)
      .then((names) => {
        if (!mountedRef.current || pointBlacklistResolutionGenerationRef.current !== generation) {
          return;
        }
        names.forEach(({ id, name }) => nameCache?.set(id, name));
        const resolvedNames = new Map(names.map((entry) => [entry.id, entry.name]));
        setPointBlacklistPalitraNames(
          palitraIds
            .map((id) => {
              const name = nameCache?.get(id) ?? resolvedNames.get(id);
              return name ? { id, name } : null;
            })
            .filter((entry): entry is PalitraName => entry !== null),
        );
      })
      .catch((loadError: unknown) => {
        if (mountedRef.current && pointBlacklistResolutionGenerationRef.current === generation) {
          setPointBlacklistLoadError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
        }
      })
      .finally(() => {
        if (mountedRef.current && pointBlacklistResolutionGenerationRef.current === generation) {
          setPointBlacklistLoading(false);
        }
      });
  }, []);

  const submitPointBlacklist = useCallback(
    async (request: AddPointHighlightBlacklistRequest, onSuccess?: () => void) => {
      if (!onAddPointHighlightBlacklist) return;
      const key = `${request.messageId}:${pointBlacklistLabelKey(request.etalon)}:${request.palitraId}`;
      if (pointBlacklistPendingKeysRef.current.has(key)) return;

      pointBlacklistPendingKeysRef.current.add(key);
      setPointBlacklistPendingKeys((current) => new Set(current).add(key));
      setPointBlacklistMutationError(null);
      try {
        await onAddPointHighlightBlacklist(request);
        if (mountedRef.current) {
          onSuccess?.();
          notify({ severity: 'success', message: 'Точку додано до чорного списку.' });
        }
      } catch (mutationError: unknown) {
        const message =
          mutationError instanceof Error ? mutationError.message : String(mutationError);
        if (mountedRef.current) {
          setPointBlacklistMutationError(`Не вдалося додати точку до чорного списку: ${message}`);
          notify({
            severity: 'error',
            message: `Не вдалося додати точку до чорного списку: ${message}`,
          });
        }
      } finally {
        pointBlacklistPendingKeysRef.current.delete(key);
        if (mountedRef.current) {
          setPointBlacklistPendingKeys((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
        }
      }
    },
    [notify, onAddPointHighlightBlacklist],
  );

  const requestPointBlacklist = useCallback(
    (source: PointBlacklistRequestSource) => {
      const palitraIds = Array.from(new Set(source.palitraIds));
      if (!onAddPointHighlightBlacklist || palitraIds.length === 0) return;
      if (palitraIds.length > 1) {
        setPointBlacklistMutationError(null);
        setPointBlacklistPalitraNames([]);
        setPointBlacklistDialog({
          request: { messageId: source.messageId, etalon: source.etalon, palitraId: palitraIds[0] },
          palitraIds,
        });
        loadPointBlacklistPalitraNames(palitraIds);
        return;
      }
      void submitPointBlacklist({
        messageId: source.messageId,
        etalon: source.etalon,
        palitraId: palitraIds[0],
      });
    },
    [loadPointBlacklistPalitraNames, onAddPointHighlightBlacklist, submitPointBlacklist],
  );

  const choosePointBlacklistPalitra = useCallback(
    (palitraId: number) => {
      if (!pointBlacklistDialog || palitraId <= 0) return;
      setPointBlacklistPendingPalitraIds((current) => new Set(current).add(palitraId));
      void submitPointBlacklist({ ...pointBlacklistDialog.request, palitraId }, () =>
        setPointBlacklistDialog(null),
      ).finally(() => {
        if (mountedRef.current) {
          setPointBlacklistPendingPalitraIds((current) => {
            const next = new Set(current);
            next.delete(palitraId);
            return next;
          });
        }
      });
    },
    [pointBlacklistDialog, submitPointBlacklist],
  );

  const retryPointBlacklistPalitraNames = useCallback(() => {
    if (pointBlacklistDialog) loadPointBlacklistPalitraNames(pointBlacklistDialog.palitraIds);
  }, [loadPointBlacklistPalitraNames, pointBlacklistDialog]);

  const imageHrefSet = useMemo(() => new Set(images.map((image) => image.href)), [images]);
  const documents = collectMessageDocuments(msg);
  const summaryMedia = [...images, ...documents];
  const [selectedSummaryMediaIndex, setSelectedSummaryMediaIndex] = useState(() =>
    Math.max(
      0,
      summaryMedia.findIndex((media) => media.id != null && media.summary != null),
    ),
  );
  const highlightSummaryMediaSelection =
    summaryMedia.length > 3 &&
    summaryMedia.some((media) => media.id != null && media.summary != null);
  const selectedSummaryImageIndex =
    highlightSummaryMediaSelection && selectedSummaryMediaIndex < images.length
      ? selectedSummaryMediaIndex
      : null;
  const selectedSummaryDocumentIndex =
    highlightSummaryMediaSelection && selectedSummaryMediaIndex >= images.length
      ? selectedSummaryMediaIndex - images.length
      : null;
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
      ...(coordinatePreviewPoints.length > 0
        ? [{ type: 'coordinate' as const, points: coordinatePreviewPoints }]
        : []),
    ],
    [coordinatePreviewPoints, images, previewableDocuments, videoPreviewSources],
  );
  const coordinatePreviewStartIndex =
    images.length + videoPreviewSources.length + previewableDocuments.length;

  const showPointLinks = messageHasPalitraTag(msg, tagsMap);
  const hasCoordinatePreview = hasCoordinatePreviewCandidate(msg, tagsMap);
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
    hasMessageTextOverflow && !isMessageTextExpanded,
    messageTextPreviewLines,
  );
  const hasTextPrimary = Array.isArray(textPrimary)
    ? textPrimary.some((node) => isPresent(node))
    : isPresent(textPrimary);

  return (
    <div className="flex flex-col min-w-0" style={{ gap: compact ? '12px' : '10px' }}>
      {pointBlacklistDialog ? (
        <PointBlacklistPaletteDialog
          state={pointBlacklistDialog}
          palitraNames={pointBlacklistPalitraNames}
          loading={pointBlacklistLoading}
          error={pointBlacklistLoadError}
          pendingPalitraIds={pointBlacklistPendingPalitraIds}
          mutationError={pointBlacklistMutationError}
          onRetry={retryPointBlacklistPalitraNames}
          onChoose={choosePointBlacklistPalitra}
          onClose={() => {
            pointBlacklistResolutionGenerationRef.current += 1;
            setPointBlacklistDialog(null);
            setPointBlacklistPalitraNames([]);
            setPointBlacklistLoading(false);
            setPointBlacklistLoadError(null);
            setPointBlacklistPendingPalitraIds(new Set());
            setPointBlacklistMutationError(null);
          }}
        />
      ) : null}
      {hasImageOrVideoAttachments ? (
        revealedVisualMedia ? (
          <MessageCardImageList
            images={images}
            videos={videoAttachments}
            selectedImageIndex={selectedSummaryImageIndex}
            onOpen={(index) => {
              blurActiveElement();
              setAttachmentPreviewIndex(index);
            }}
            onOpenVideo={(index) => {
              blurActiveElement();
              setAttachmentPreviewIndex(images.length + index);
            }}
          />
        ) : (
          <MessageCardMediaRevealBanner
            kind="visuals"
            label={formatMessageVisualRevealLabel(images.length, videoAttachments.length)}
            icon={messageCardVisualRevealIcon(images.length, videoAttachments.length)}
            onReveal={() => setRevealedVisualMedia(true)}
          />
        )
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
        revealedAudioMedia ? (
          <div className="mt-1 flex flex-col items-start w-full">
            {audioAttachments.map((attachment) => (
              <MessageMediaAudioPlayer
                key={attachment.id}
                attachment={attachment}
                isDownloadStarting={isDownloadStarting}
                onDownloadStart={onDownloadStart}
              />
            ))}
          </div>
        ) : (
          <MessageCardMediaRevealBanner
            kind="audio"
            label={formatMessageAudioRevealLabel(audioAttachments.length)}
            icon={MESSAGE_CARD_AUDIO_REVEAL_ICON}
            onReveal={() => setRevealedAudioMedia(true)}
          />
        )
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
                selected={selectedSummaryDocumentIndex === index}
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
      {mediaSummaryEnabled ? (
        <MessageCardMediaSummaryCarousel
          media={summaryMedia}
          onIndexChange={setSelectedSummaryMediaIndex}
        />
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
      {hasCoordinatePreview ? (
        revealedCoordinateMedia ? (
          <MessageCardCoordinateAttachment
            msg={msg}
            tagsMap={tagsMap}
            onPointsChange={setCoordinatePreviewPoints}
            onOpen={() => {
              blurActiveElement();
              setAttachmentPreviewIndex(coordinatePreviewStartIndex);
            }}
          />
        ) : (
          <MessageCardMediaRevealBanner
            kind="coordinates"
            label="Координати"
            icon={MESSAGE_CARD_COORDINATE_REVEAL_ICON}
            onReveal={() => setRevealedCoordinateMedia(true)}
          />
        )
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
      <MessageCardIntelligenceReports
        reports={getIntelligenceReports(msg)}
        parents={getParentMessages(msg)}
        groupInfos={reportGroupInfos}
        onEdit={readOnly ? undefined : onEditReport}
      />
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
  showTextPreview = false,
  messageTextPreviewLines: 20 | 40 | null = 20,
) {
  const messageText = msg.text ?? '';
  const visibleText =
    showTextPreview && messageTextPreviewLines !== null
      ? previewTextRows(messageText, messageTextPreviewLines)
      : messageText;
  return msg.textMarked && msg.textMarked.length > 0
    ? renderMarkedText(
        showTextPreview && messageTextPreviewLines !== null
          ? previewMarkedTextRows(msg.textMarked, messageTextPreviewLines)
          : msg.textMarked,
        visibleText,
        getPointEtalonsFromMessage(msg, tagsMap),
        {
          showPointLinks,
          message: msg,
          messageId,
          onOpenPointsOnMap,
          onRequestPointBlacklist,
          pendingBlacklistKeys,
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
