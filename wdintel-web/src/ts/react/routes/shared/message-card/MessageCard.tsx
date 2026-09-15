import { styled } from '@mui/material/styles';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { memo, useMemo } from 'react';
import type { MouseEvent } from 'react';
import type {
  CallsignInfoRes,
  InboxMessage,
  MessageComment,
  Network,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SignalGroupEntry,
  Tag,
  Unit,
} from '../../../../../Bindings';
import { MessageCardContentWithDownloadGuard } from './MessageCardContent';
import { MessageCardWatermark } from './MessageCardWatermark';
import type { AnalysisCallsignActions, MessageCardBotTagAction } from './message-card.types';
import {
  MessageCardHeader,
  MessageCardMetadata,
  type MessageCardDisplayMode,
  type MessageCardHeaderProps,
} from './MessageCardHeader';
import { MessageCardDmrMetadataPopover } from './MessageCardDmrMetadataPopover';
import { hasVisibleDmrMetadata } from './message-card-metadata';
import { useRelativeTimeDisplayMs } from './useRelativeTimeDisplayMs';
import { APP_TIME_ZONE, isPresent, NO_DATA_LABEL } from '../../../utils/misc';
import {
  buildClassicAnalysisHref,
  buildClassicAnalysisMapHrefWithSearch,
  buildAnalysisHref,
  buildAnalysisMapHrefWithSearch,
  buildVisibleExcludeMenuOptions,
  emptyFilter,
  getPointEtalonsFromMessage,
  messageRenderDistance,
  type MessageEntityExcludeMenuOption,
  type MessageEntityFilterKind,
  type TagsLayoutVariant,
} from '../../rer-duty-neo/utils';
import { resolveMessageCardEtalonDisplayModel } from './message-card.utils';
import type { AddPointHighlightBlacklistRequest } from './point-highlight-blacklist';
import type {
  MessageTextPreviewLineLimit,
  MessageTimeBasis,
} from '../../../services/api/user-settings';
import { DEFAULT_MEDIA_SUMMARY_ENABLED } from '../../../hooks/duty-settings-defaults';
import {
  canDownloadAllMessageAttachments,
  guardMessageCardDownloadClick,
  MESSAGE_CARD_ATTACHMENTS_ARCHIVE_DOWNLOAD_KEY,
  MESSAGE_CARD_ATTACHMENTS_ARCHIVE_FILE_NAME,
  MESSAGE_CARD_ATTACHMENTS_ARCHIVE_LABEL,
  messageCardAttachmentsArchiveHref,
  useMessageCardDownloadGuard,
} from './MessageCardMedia';

dayjs.extend(customParseFormat);

// Hoisted so repeated renders (e.g. every message card in a scrolling feed) share a single
// stable reference for these "empty" defaults, instead of allocating a fresh object/array
// per render that would otherwise defeat React.memo and downstream useMemo dependency checks.
const EMPTY_FILTER: RerDutyFeedFilterState = emptyFilter();
const EMPTY_MESSAGE_COMMENTS: MessageComment[] = [];
const EMPTY_EXCLUDE_OPTIONS: MessageEntityExcludeMenuOption[] = [];
const EMPTY_GROUP_INFOS: Record<string, SignalGroupEntry> = {};
const ANALYSIS_MESSAGE_CARD_VISIBILITY_STYLE = {
  contentVisibility: 'auto',
  containIntrinsicBlockSize: 'auto 120px',
} as const;

const MessageCardRoot = styled('div')(({ theme }) => ({
  ...theme.typography.body2,
}));

export function formatMessageCardTooltipTime(
  msg: Pick<InboxMessage, 'time' | 'timestamp'>,
  preferTimestamp = false,
): string {
  if (preferTimestamp && isPresent(msg.timestamp)) {
    return dayjs(msg.timestamp).tz(APP_TIME_ZONE).format('HH:mm:ss');
  }
  const time = msg.time;
  if (time === null) return NO_DATA_LABEL;
  const trimmed = time.trim();
  if (trimmed === '') return NO_DATA_LABEL;

  const parsed = dayjs(trimmed, ['HH:mm:ss', 'HH:mm'], true);
  if (parsed.isValid()) {
    if (trimmed.split(':').length >= 3) return parsed.format('HH:mm:ss');
    if (isPresent(msg.timestamp)) return dayjs(msg.timestamp).tz(APP_TIME_ZONE).format('HH:mm:ss');
    return parsed.format('HH:mm');
  }

  if (isPresent(msg.timestamp)) return dayjs(msg.timestamp).tz(APP_TIME_ZONE).format('HH:mm:ss');
  return trimmed;
}

export type MessageCardProps = {
  id: number;
  msg: InboxMessage;
  readOnly?: boolean;
  /** Number of feeds (columns). When >= 3, header columns use differential shrink (left 3, center 2, right 0). When 1 or 2, all columns shrink equally. */
  feedCount?: number;
  /** Duty vs analysis: controls stacked action icon grid width (4 vs 3 columns). */
  displayMode?: MessageCardDisplayMode;
  analysisDestination?: 'classic' | 'neo';
  /** Tag chips section visual density mode. */
  tagsLayout?: TagsLayoutVariant;
  hideBotTags?: boolean;
  tagsLoading?: boolean;
  /** Baseline "now" when the card is off-screen; while visible, relative time updates every second. */
  referenceTimeMs: number | null;
  /** Auth user display name for background watermark */
  authUserName: string | null;
  tagContributionsOrganismId?: number;
  groupName: string | null;
  reportGroupInfos?: Record<string, SignalGroupEntry>;
  senderName: string | null;
  copiedFeedbackId: string | null;
  networkDisplayMap: Record<number, string>;
  filterState?: RerDutyFeedFilterState;
  messageComments?: MessageComment[];
  searchText?: string | null;
  /** Loaded network models (for «в дорозвідці» badge); keys match `msg.networkIds`. */
  networkMap?: Record<number, Network>;
  /** When false, allow `msg.unit` fallback when network ids are empty. */
  featureStrictNetworks?: boolean;
  tagsMap: Record<number, Tag>;
  tagsOrder?: number[];
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
  onBookmark?: () => void;
  onImportant?: () => void;
  onCopyText?: () => void;
  onCopyFreq?: () => void;
  onCopyTextWithNetwork?: () => void;
  onCopyTextWithNetworkAndNote?: () => void;
  onCopyMessageLink?: () => void;
  onCopyEtalon?: () => void;
  onCopyLocation?: () => void;
  onCreateReport?: () => void;
  onEditReport?: (reportId: number) => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  onExcludeMessageEntity?: (entity: MessageEntityFilterKind, value: string) => void;
  onToggleTag?: (tagId: number) => void;
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
  onAddPointHighlightBlacklist?: (request: AddPointHighlightBlacklistRequest) => Promise<void>;
  botTagAction?: MessageCardBotTagAction | null;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void | Promise<void>;
  rightHeaderInsetPx?: number;
  analysisCallsignActions?: AnalysisCallsignActions;
  showCallsignAddForm?: boolean;
  /**
   * When true, Duty-style cards hide heavy media behind reveal banners until clicked.
   * Defaults to true for `displayMode="duty"`.
   */
  collapseMediaPreviews?: boolean;
  mediaSummaryEnabled?: boolean;
  messageTextPreviewLines?: MessageTextPreviewLineLimit;
  messageTimeBasis?: MessageTimeBasis;
};

// Performance boundary: this component is repeated throughout Duty feeds.
// Keep structural markup native and theme-aware; see ./AGENTS.md before adding layout wrappers.
function MessageCardComponent({
  id,
  msg,
  readOnly = false,
  feedCount = 1,
  displayMode = 'duty',
  analysisDestination = 'classic',
  tagsLayout = 'full',
  hideBotTags = false,
  tagsLoading = false,
  referenceTimeMs,
  authUserName,
  tagContributionsOrganismId,
  groupName,
  reportGroupInfos = EMPTY_GROUP_INFOS,
  senderName,
  copiedFeedbackId,
  networkDisplayMap,
  filterState = EMPTY_FILTER,
  messageComments = EMPTY_MESSAGE_COMMENTS,
  searchText,
  networkMap = {},
  featureStrictNetworks = false,
  tagsMap,
  tagsOrder,
  callsignInfoMap,
  networks,
  unitsMap,
  onBookmark,
  onImportant,
  onCopyText,
  onCopyFreq,
  onCopyTextWithNetwork,
  onCopyTextWithNetworkAndNote,
  onCopyMessageLink,
  onCopyEtalon,
  onCopyLocation,
  onCreateReport,
  onEditReport,
  onDelete,
  onEditDetails,
  onExcludeMessageEntity,
  onToggleTag,
  onOpenPointsOnMap,
  onAddPointHighlightBlacklist,
  botTagAction = null,
  onCancelBotTagAction,
  onMarkBotTagWrong,
  rightHeaderInsetPx = 0,
  analysisCallsignActions,
  showCallsignAddForm = false,
  collapseMediaPreviews,
  mediaSummaryEnabled = DEFAULT_MEDIA_SUMMARY_ENABLED,
  messageTextPreviewLines = 20,
  messageTimeBasis = 'interception',
}: MessageCardProps) {
  const displayTimestamp = messageTimeBasis === 'creation' ? msg.createdAt : msg.timestamp;
  const [messageRootRef, relativeTimeMs] = useRelativeTimeDisplayMs(
    referenceTimeMs,
    displayTimestamp,
  );
  const downloadGuard = useMessageCardDownloadGuard();
  const compactLayout = feedCount >= 3;
  const derivedNetworkMap = useMemo(() => {
    if (Object.keys(networkMap).length > 0) return networkMap;
    if (!networks) return {};
    return Object.fromEntries(networks.map((network) => [network.id, network]));
  }, [networkMap, networks]);
  const etalonDisplayModel = useMemo(
    () =>
      resolveMessageCardEtalonDisplayModel(msg, {
        featureStrictNetworks,
        networkDisplayMap,
        networkMap: derivedNetworkMap,
        networks,
      }),
    [msg, featureStrictNetworks, networkDisplayMap, derivedNetworkMap, networks],
  );
  const onCopyEtalonAction = etalonDisplayModel.copyEtalonValue == null ? undefined : onCopyEtalon;
  const onCopyLocationAction =
    etalonDisplayModel.copyLocationValue == null ? undefined : onCopyLocation;
  const pointEtalons = useMemo(() => getPointEtalonsFromMessage(msg, tagsMap), [msg, tagsMap]);
  const excludeSources = useMemo(
    () => ({
      group: { value: msg.groupMasterKey, label: groupName },
      sender: { value: msg.sender, label: senderName },
      freq: { value: msg.freq, label: msg.freq },
      post: { value: msg.post, label: msg.post },
    }),
    [msg.groupMasterKey, groupName, msg.sender, senderName, msg.freq, msg.post],
  );
  const excludeMenuOptions = useMemo(
    () =>
      displayMode === 'duty'
        ? buildVisibleExcludeMenuOptions(filterState, excludeSources)
        : EMPTY_EXCLUDE_OPTIONS,
    [displayMode, filterState, excludeSources],
  );
  const mapHref = useMemo(
    () =>
      displayMode === 'duty'
        ? pointEtalons.length > 0
          ? analysisDestination === 'neo'
            ? buildAnalysisMapHrefWithSearch(pointEtalons, msg)
            : buildClassicAnalysisMapHrefWithSearch(pointEtalons, msg)
          : analysisDestination === 'neo'
            ? buildAnalysisHref(msg, true)
            : buildClassicAnalysisHref(msg, true)
        : undefined,
    [analysisDestination, displayMode, pointEtalons, msg],
  );
  const watermarkUserName = authUserName?.trim() ?? '';
  const timeDistance =
    isPresent(displayTimestamp) && isPresent(relativeTimeMs)
      ? messageRenderDistance(displayTimestamp, relativeTimeMs)
      : null;
  const tooltipTime = useMemo(
    () =>
      formatMessageCardTooltipTime(
        { ...msg, timestamp: displayTimestamp },
        messageTimeBasis === 'creation',
      ),
    [displayTimestamp, messageTimeBasis, msg],
  );

  const topRight =
    displayMode === 'duty' ? (
      isPresent(timeDistance) ? (
        <div className="flex-1 min-w-0 flex justify-end">
          <span
            className="message-card-relative-time"
            title={tooltipTime === NO_DATA_LABEL ? undefined : tooltipTime}
          >
            {timeDistance}
          </span>
        </div>
      ) : (
        <div className="min-h-[28px]" />
      )
    ) : (
      <div className="min-h-[28px]" />
    );

  const analysisHref = useMemo(
    () =>
      displayMode === 'duty'
        ? analysisDestination === 'neo'
          ? buildAnalysisHref(msg, false)
          : buildClassicAnalysisHref(msg, false)
        : undefined,
    [analysisDestination, displayMode, msg],
  );
  const metadataTrigger =
    displayMode === 'analysis' && hasVisibleDmrMetadata(msg) ? (
      <MessageCardDmrMetadataPopover msg={msg} />
    ) : undefined;
  const canDownloadAllAttachments = canDownloadAllMessageAttachments(msg.media ?? []);
  const archiveDownloadStarting = downloadGuard.isDownloadStarting(
    MESSAGE_CARD_ATTACHMENTS_ARCHIVE_DOWNLOAD_KEY,
  );
  const attachmentArchiveDownload = canDownloadAllAttachments
    ? {
        href: messageCardAttachmentsArchiveHref(id),
        download: MESSAGE_CARD_ATTACHMENTS_ARCHIVE_FILE_NAME,
        label: MESSAGE_CARD_ATTACHMENTS_ARCHIVE_LABEL,
        disabled: archiveDownloadStarting,
        ariaBusy: archiveDownloadStarting,
        ariaLabel: archiveDownloadStarting
          ? 'Завантаження…'
          : MESSAGE_CARD_ATTACHMENTS_ARCHIVE_LABEL,
        onClick: (event: MouseEvent<HTMLElement>) =>
          guardMessageCardDownloadClick(event, MESSAGE_CARD_ATTACHMENTS_ARCHIVE_DOWNLOAD_KEY, {
            isDownloadStarting: downloadGuard.isDownloadStarting,
            onDownloadStart: downloadGuard.onDownloadStart,
          }),
      }
    : undefined;

  const headerProps: MessageCardHeaderProps = {
    compact: compactLayout,
    displayMode,
    id,
    msg,
    displayTimestamp: messageTimeBasis === 'creation' ? displayTimestamp : undefined,
    copiedFeedbackId,
    etalonDisplayModel,
    mapHref,
    analysisHref,
    rightInsetPx: rightHeaderInsetPx,
    topRight,
    onBookmark,
    onImportant,
    onCreateReport,
    onCopyText,
    onCopyFreq,
    onCopyTextWithNetwork,
    onCopyTextWithNetworkAndNote,
    onCopyMessageLink,
    onCopyEtalon: onCopyEtalonAction,
    onCopyLocation: onCopyLocationAction,
    onDelete,
    onEditDetails,
    onExcludeMessageEntity,
    excludeMenuOptions,
    attachmentArchiveDownload,
    readOnly,
  };
  const visibleMessageComments = messageComments;

  return (
    <li
      ref={messageRootRef as React.RefObject<HTMLLIElement>}
      data-message-id={id}
      data-message-uid={msg.messageUid ?? undefined}
      className="message-card-item list-none flex flex-col px-0 pb-[12px] mb-0"
      style={displayMode === 'analysis' ? ANALYSIS_MESSAGE_CARD_VISIBILITY_STYLE : undefined}
    >
      <MessageCardRoot
        data-message-card-root="true"
        className="message-card-root relative flex w-full flex-col overflow-hidden"
      >
        {watermarkUserName !== '' && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
            <MessageCardWatermark authUserName={watermarkUserName} />
          </div>
        )}
        <MessageCardHeader {...headerProps} />
        <MessageCardContentWithDownloadGuard
          metadata={
            <MessageCardMetadata
              msg={msg}
              groupName={groupName}
              senderName={senderName}
              etalonDisplayModel={etalonDisplayModel}
              metadataTrigger={metadataTrigger}
            />
          }
          messageId={id}
          msg={msg}
          tagsMap={tagsMap}
          tagsOrder={tagsOrder}
          tagContributionsOrganismId={tagContributionsOrganismId}
          hideBotTags={hideBotTags}
          tagsLoading={tagsLoading}
          onToggleTag={onToggleTag}
          readOnly={readOnly}
          tagsLayout={tagsLayout}
          botTagAction={botTagAction}
          onCancelBotTagAction={onCancelBotTagAction}
          onMarkBotTagWrong={onMarkBotTagWrong}
          analysisCallsignActions={analysisCallsignActions}
          showCallsignAddForm={showCallsignAddForm}
          callsignInfoMap={callsignInfoMap}
          networks={networks}
          unitsMap={unitsMap}
          messageComments={visibleMessageComments}
          reportGroupInfos={reportGroupInfos}
          onEditReport={onEditReport}
          signalMessageSenderLabel={senderName?.trim() ? senderName : msg.sender}
          searchText={searchText}
          onOpenPointsOnMap={onOpenPointsOnMap}
          onAddPointHighlightBlacklist={onAddPointHighlightBlacklist}
          collapseMediaPreviews={collapseMediaPreviews ?? false}
          mediaSummaryEnabled={mediaSummaryEnabled}
          messageTextPreviewLines={messageTextPreviewLines}
          messageTimeBasis={messageTimeBasis}
          isDownloadStarting={downloadGuard.isDownloadStarting}
          onDownloadStart={downloadGuard.onDownloadStart}
        />
      </MessageCardRoot>
    </li>
  );
}

export const MessageCard = memo(MessageCardComponent);

type BaseMessageCardProps = Omit<MessageCardProps, 'displayMode'>;

export function DutyMessageCard(props: BaseMessageCardProps) {
  return <MessageCard {...props} displayMode="duty" />;
}

export function AnalysisMessageCard(props: BaseMessageCardProps) {
  return <MessageCard {...props} displayMode="analysis" />;
}
