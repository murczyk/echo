import type {
  CallsignInfoRes,
  ContentNode,
  InboxMessage,
  MediaSummaryStatus,
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
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import GpsFixedOutlinedIcon from '@mui/icons-material/GpsFixedOutlined';
import PhotoOutlinedIcon from '@mui/icons-material/PhotoOutlined';
import VolumeUpOutlinedIcon from '@mui/icons-material/VolumeUpOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { isPresent } from '../../../utils/misc';
import {
  getPointEtalonsFromMessage,
  messageHasPalitraTag,
  type TagsLayoutVariant,
} from '../../rer-duty-neo/utils';
import { renderMarkedText } from './MarkedText';
import { renderLinkifiedText } from './message-card-linkify';
import { MessageCardComments } from './MessageCardComments';
import { MessageCardCallsignsSection } from './MessageCardCallsignsSection';
import { MessageCardCoordinateAttachment } from './MessageCardCoordinateAttachment';
import {
  hasCoordinatePreviewCandidate,
  resolveMessageCoordinatePreviewSummaryCount,
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
import {
  hasVisibleMessageCardIntelligenceReports,
  MessageCardIntelligenceReports,
} from './MessageCardIntelligenceReports';
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

type ActiveAttachmentSection = 'media' | 'coordinates' | 'documents' | 'audio' | null;

type CardSummaryItem = {
  identity: string;
  mediaId: string | null;
  kind: 'media' | 'document';
  summary: MediaSummaryStatus | null;
};

function normalizeAttachmentHref(href: unknown): string {
  return String(href ?? '').trim();
}

function summaryAttachmentIdentity(attachment: {
  id?: string | null;
  href?: string | null;
}): string {
  return `${attachment.id ?? ''}\u0000${normalizeAttachmentHref(attachment.href)}`;
}

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
  metadata,
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
  metadata?: ReactNode;
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
  const [activeAttachmentSection, setActiveAttachmentSection] =
    useState<ActiveAttachmentSection>(null);
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
    setActiveAttachmentSection(null);
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

  const imageHrefSet = useMemo(
    () => new Set(images.map((image) => normalizeAttachmentHref(image.href))),
    [images],
  );
  const documents = collectMessageDocuments(msg);
  const previewableDocuments = documents.filter((document) => document.kind !== 'unsupported');
  const documentHrefSet = new Set(
    documents.map((document) => normalizeAttachmentHref(document.href)),
  );
  const attachmentMedia = (msg.media ?? []).filter((attachment) => {
    const href = normalizeAttachmentHref(attachment.href);
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
  const mediaAttachmentCount = images.length + videoAttachments.length;
  const documentAttachmentCount = documents.length + downloadAttachments.length;
  const hasMediaAttachments = mediaAttachmentCount > 0;
  const hasDocumentAttachments = documentAttachmentCount > 0;
  const isMediaVisible = !collapseMediaPreviews || activeAttachmentSection === 'media';
  const isDocumentVisible = !collapseMediaPreviews || activeAttachmentSection === 'documents';
  const isCoordinateVisible = !collapseMediaPreviews || activeAttachmentSection === 'coordinates';
  const isAudioVisible = !collapseMediaPreviews || activeAttachmentSection === 'audio';
  const cardSummaryItems = useMemo<CardSummaryItem[]>(
    () => [
      ...images.map((image) => ({
        identity: summaryAttachmentIdentity(image),
        mediaId: image.id ?? null,
        kind: 'media' as const,
        summary: image.summary ?? null,
      })),
      ...videoAttachments.map((attachment) => ({
        identity: summaryAttachmentIdentity(attachment),
        mediaId: attachment.id ?? null,
        kind: 'media' as const,
        summary: attachment.summary ?? null,
      })),
      ...documents.map((document) => ({
        identity: summaryAttachmentIdentity(document),
        mediaId: document.id ?? null,
        kind: 'document' as const,
        summary: document.summary ?? null,
      })),
      ...downloadAttachments.map((attachment) => ({
        identity: summaryAttachmentIdentity(attachment),
        mediaId: attachment.id ?? null,
        kind: 'document' as const,
        summary: attachment.summary ?? null,
      })),
    ],
    [documents, downloadAttachments, images, videoAttachments],
  );
  const summaryScope = useMemo(
    () =>
      cardSummaryItems.filter((item) => {
        if (!collapseMediaPreviews) return true;
        return activeAttachmentSection === (item.kind === 'document' ? 'documents' : item.kind);
      }),
    [activeAttachmentSection, cardSummaryItems, collapseMediaPreviews],
  );
  const summaryScopeIdentity = summaryScope
    .map((item) => `${item.identity}:${item.summary?.state ?? ''}`)
    .join('\0');
  const showSummaryCarousel =
    mediaSummaryEnabled && summaryScope.some((item) => item.summary != null);
  const [selectedSummaryIdentity, setSelectedSummaryIdentity] = useState<string | null>(null);
  useEffect(() => {
    if (!showSummaryCarousel) {
      setSelectedSummaryIdentity(null);
      return;
    }
    setSelectedSummaryIdentity((current) => {
      if (current != null && summaryScope.some((item) => item.identity === current)) return current;
      return summaryScope.find((item) => item.summary != null)?.identity ?? null;
    });
  }, [showSummaryCarousel, summaryScopeIdentity]);
  const selectedSummaryMediaIdentity =
    showSummaryCarousel &&
    selectedSummaryIdentity != null &&
    summaryScope.some((item) => item.identity === selectedSummaryIdentity)
      ? selectedSummaryIdentity
      : showSummaryCarousel
        ? (summaryScope.find((item) => item.summary != null)?.identity ?? null)
        : null;
  const selectedSummaryImageIndex = selectedSummaryMediaIdentity
    ? images.findIndex((image) => summaryAttachmentIdentity(image) === selectedSummaryMediaIdentity)
    : -1;
  const selectedSummaryVideoIndex = selectedSummaryMediaIdentity
    ? videoAttachments.findIndex(
        (attachment) => summaryAttachmentIdentity(attachment) === selectedSummaryMediaIdentity,
      )
    : -1;
  const selectedSummaryDocumentIndex = selectedSummaryMediaIdentity
    ? documents.findIndex(
        (document) => summaryAttachmentIdentity(document) === selectedSummaryMediaIdentity,
      )
    : -1;

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
  const coordinateSummaryCount = resolveMessageCoordinatePreviewSummaryCount(msg, tagsMap);
  const coordinateAttachmentCount =
    coordinatePreviewPoints.length > 0 ? coordinatePreviewPoints.length : coordinateSummaryCount;
  const hasTags = tagsLayout !== 'hidden' && Object.keys(tagsMap).length > 0;
  const visibleBotTagAction =
    !readOnly && botTagAction?.messageId === messageId ? botTagAction : null;
  const reports = getIntelligenceReports(msg);
  const parents = getParentMessages(msg);
  const hasCallsignControls = !readOnly && isPresent(analysisCallsignActions);
  const hasVisibleReports = hasVisibleMessageCardIntelligenceReports(reports, parents);
  const hasSidebarContent = tagsLoading || hasTags || hasCallsignControls || hasVisibleReports;
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

  const messageTextSection =
    hasTextPrimary || hasMessageTextOverflow ? (
      <>
        {metadata ? <div className="message-card-divider" /> : null}
        <div className="message-card-main-section message-card-message-text">
          <div
            className={
              msg.textMarked && msg.textMarked.length > 0
                ? 'text-marked whitespace-pre-wrap wrap-break-word'
                : 'whitespace-pre-wrap wrap-break-word'
            }
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
                className="message-card-text-expand"
              >
                {isMessageTextExpanded ? 'згорнути' : 'розгорнути'}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="message-card-divider" />
      </>
    ) : null;

  const toggleAttachmentSection = (section: Exclude<ActiveAttachmentSection, null>) => {
    setActiveAttachmentSection((current) => (current === section ? null : section));
  };

  const attachmentCounters =
    collapseMediaPreviews &&
    (hasMediaAttachments ||
      hasDocumentAttachments ||
      coordinateAttachmentCount > 0 ||
      audioAttachments.length > 0) ? (
      <div className="message-card-attachment-counters" aria-label="Вкладення повідомлення">
        {hasMediaAttachments ? (
          <button
            type="button"
            className="message-card-attachment-counter"
            data-attachment-kind="media"
            data-expanded={isMediaVisible}
            aria-pressed={isMediaVisible}
            aria-expanded={isMediaVisible}
            aria-label={`${isMediaVisible ? 'Згорнути' : 'Розгорнути'} медіа: ${mediaAttachmentCount}`}
            onClick={() => toggleAttachmentSection('media')}
          >
            <PhotoOutlinedIcon aria-hidden />
            <span className="message-card-attachment-counter__label">МЕДІА</span>
            <span className="message-card-attachment-counter__count">{mediaAttachmentCount}</span>
          </button>
        ) : null}
        {hasDocumentAttachments ? (
          <button
            type="button"
            className="message-card-attachment-counter"
            data-attachment-kind="documents"
            data-expanded={isDocumentVisible}
            aria-pressed={isDocumentVisible}
            aria-expanded={isDocumentVisible}
            aria-label={`${isDocumentVisible ? 'Згорнути' : 'Розгорнути'} документи: ${documentAttachmentCount}`}
            onClick={() => toggleAttachmentSection('documents')}
          >
            <DescriptionOutlinedIcon aria-hidden />
            <span className="message-card-attachment-counter__label">ДОКУМЕНТИ</span>
            <span className="message-card-attachment-counter__count">
              {documentAttachmentCount}
            </span>
          </button>
        ) : null}
        {coordinateAttachmentCount > 0 ? (
          <button
            type="button"
            className="message-card-attachment-counter"
            data-attachment-kind="coordinates"
            data-expanded={isCoordinateVisible}
            aria-pressed={isCoordinateVisible}
            aria-expanded={isCoordinateVisible}
            aria-label={`${isCoordinateVisible ? 'Згорнути' : 'Розгорнути'} координати: ${coordinateAttachmentCount}`}
            onClick={() => toggleAttachmentSection('coordinates')}
          >
            <GpsFixedOutlinedIcon aria-hidden />
            <span className="message-card-attachment-counter__label">КООРДИНАТИ</span>
            <span className="message-card-attachment-counter__count">
              {coordinateAttachmentCount}
            </span>
          </button>
        ) : null}
        {audioAttachments.length > 0 ? (
          <button
            type="button"
            className="message-card-attachment-counter"
            data-attachment-kind="audio"
            data-expanded={isAudioVisible}
            aria-pressed={isAudioVisible}
            aria-expanded={isAudioVisible}
            aria-label={`${isAudioVisible ? 'Згорнути' : 'Розгорнути'} аудіо: ${audioAttachments.length}`}
            onClick={() => toggleAttachmentSection('audio')}
          >
            <VolumeUpOutlinedIcon aria-hidden />
            <span className="message-card-attachment-counter__label">АУДІО</span>
            <span className="message-card-attachment-counter__count">
              {audioAttachments.length}
            </span>
          </button>
        ) : null}
      </div>
    ) : null;

  const tagsSection = tagsLoading ? (
    <div className="min-h-6" aria-label="Завантаження тегів">
      <CircularProgress size={14} />
    </div>
  ) : hasTags ? (
    <MessageCardTags
      msg={msg}
      tagsMap={tagsMap}
      tagsOrder={tagsOrder}
      tagContributionsOrganismId={tagContributionsOrganismId}
      onToggleTag={onToggleTag}
      tagsLayout={tagsLayout}
      interactive={!readOnly && onToggleTag != null}
      botTagAction={visibleBotTagAction}
      onCancelBotTagAction={visibleBotTagAction != null ? onCancelBotTagAction : undefined}
      onMarkBotTagWrong={visibleBotTagAction != null ? onMarkBotTagWrong : undefined}
    />
  ) : null;

  const coordinateAttachment =
    hasCoordinatePreview && isCoordinateVisible ? (
      <MessageCardCoordinateAttachment
        msg={msg}
        tagsMap={tagsMap}
        onPointsChange={setCoordinatePreviewPoints}
        onOpen={() => {
          blurActiveElement();
          setAttachmentPreviewIndex(coordinatePreviewStartIndex);
        }}
      />
    ) : null;

  return (
    <div className="message-card-content">
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
      <div
        className={
          hasSidebarContent
            ? 'message-card-content-layout message-card-content-layout--with-sidebar'
            : 'message-card-content-layout'
        }
      >
        <div className="message-card-main">
          {metadata ? <div className="message-card-main-section">{metadata}</div> : null}
          {messageTextSection}
          {attachmentCounters}
          {isMediaVisible || (!collapseMediaPreviews && coordinateAttachment != null) ? (
            <MessageCardImageList
              images={isMediaVisible ? images : []}
              videos={isMediaVisible ? videoAttachments : []}
              trailingContent={!collapseMediaPreviews ? coordinateAttachment : null}
              selectedImageIndex={selectedSummaryImageIndex >= 0 ? selectedSummaryImageIndex : null}
              selectedVideoIndex={selectedSummaryVideoIndex >= 0 ? selectedSummaryVideoIndex : null}
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
          {isDocumentVisible && hasDocumentAttachments ? (
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
                  selected={
                    selectedSummaryMediaIdentity != null &&
                    summaryAttachmentIdentity(attachment) === selectedSummaryMediaIdentity
                  }
                  isDownloadStarting={isDownloadStarting}
                  onDownloadStart={onDownloadStart}
                />
              ))}
            </div>
          ) : null}
          {((!collapseMediaPreviews && (hasMediaAttachments || hasDocumentAttachments)) ||
            (isDocumentVisible && hasDocumentAttachments)) &&
          canDownloadAllAttachments ? (
            <div className="mt-1 flex items-start w-full">
              <MessageMediaDownloadAllLink
                messageId={messageId}
                isDownloadStarting={isDownloadStarting}
                onDownloadStart={onDownloadStart}
              />
            </div>
          ) : null}
          {showSummaryCarousel && selectedSummaryMediaIdentity != null ? (
            <MessageCardMediaSummaryCarousel
              items={summaryScope}
              selectedIdentity={selectedSummaryMediaIdentity}
              onSelectedIdentityChange={setSelectedSummaryIdentity}
            />
          ) : null}
          {collapseMediaPreviews ? coordinateAttachment : null}
          {audioAttachments.length > 0 && isAudioVisible ? (
            <div className="mt-1 flex flex-col items-start w-full">
              {audioAttachments.map((attachment) => (
                <MessageMediaAudioPlayer
                  key={attachment.id}
                  attachment={attachment}
                  isDownloadStarting={isDownloadStarting}
                  onDownloadStart={onDownloadStart}
                />
              ))}
              {!hasMediaAttachments && canDownloadAllAttachments ? (
                <div className="mt-1 flex items-start w-full">
                  <MessageMediaDownloadAllLink
                    messageId={messageId}
                    isDownloadStarting={isDownloadStarting}
                    onDownloadStart={onDownloadStart}
                  />
                </div>
              ) : null}
            </div>
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
        </div>
        {hasSidebarContent ? (
          <div className="message-card-sidebar">
            {tagsSection}
            {hasCallsignControls ? (
              <MessageCardCallsignsSection
                msg={msg}
                actions={analysisCallsignActions}
                callsignInfoMap={callsignInfoMap}
                showAddForm={showCallsignAddForm}
              />
            ) : null}
            {hasVisibleReports && (tagsSection != null || hasCallsignControls) ? (
              <div className="message-card-divider" />
            ) : null}
            <MessageCardIntelligenceReports
              reports={reports}
              parents={parents}
              groupInfos={reportGroupInfos}
              onEdit={readOnly ? undefined : onEditReport}
            />
          </div>
        ) : null}
      </div>
      {messageComments.length > 0 ? (
        <MessageCardComments
          messageComments={messageComments}
          signalMessageSenderLabel={signalMessageSenderLabel}
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
