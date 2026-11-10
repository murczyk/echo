import { useMessageReplies } from '../message-replies/MessageRepliesProvider';
import { MessageReplyChain } from '../message-replies/MessageReplyChain';
import { useMessageDeleteAccess, useMessageWriteAccess } from './MessageWriteAccess';
import { DutyExcludeMenuContext } from './DutyExcludeMenu';
import { useRadioFeatures } from '../RadioFeatures';
import { styled } from '@mui/material/styles';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { memo, useContext, useMemo } from 'react';
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
  MessageCardMetadataPlacement,
  MessageCardTimestampFooter,
  type MessageCardDisplayMode,
  type MessageCardHeaderProps,
} from './MessageCardHeader';
import { MessageCardDmrMetadataPopover } from './MessageCardDmrMetadataPopover';
import { useMessageDeviceAccess } from './MessageDeviceAccess';
import { hasVisibleDmrMetadata } from './message-card-metadata';
import { APP_TIME_ZONE, isPresent, NO_DATA_LABEL } from '../../../utils/misc';
import {
  buildClassicAnalysisHref,
  buildClassicAnalysisMapHrefWithSearch,
  buildAnalysisHref,
  buildAnalysisMapHrefWithSearch,
  buildVisibleExcludeMenuOptions,
  emptyFilter,
  getPointEtalonsFromMessage,
  type MessageEntityExcludeMenuOption,
  type MessageEntityFilterKind,
  type TagsLayoutVariant,
} from '../../rer-duty-neo/utils';
import {
  hideMessageCardNetworks,
  resolveMessageCardEtalonDisplayModel,
} from './message-card.utils';
import type { MessageCardEtalonDisplayModel } from './message-card.utils';
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
  '--message-card-metadata-text-color': theme.palette.text.secondary,
}));

export function formatMessageCardTooltipTime(
  msg: Pick<InboxMessage, 'time' | 'timestamp'> & Partial<Pick<InboxMessage, 'isTimeNull'>>,
  preferTimestamp = false,
): string {
  if (msg.isTimeNull === true) return NO_DATA_LABEL;
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
  displayMode?: MessageCardDisplayMode;
  analysisDestination?: 'classic' | 'neo';
  /** Tag chips section visual density mode. */
  tagsLayout?: TagsLayoutVariant;
  hideBotTags?: boolean;
  hideNetworks?: boolean;
  tagsLoading?: boolean;
  /** Baseline "now" when the card is off-screen; visible dates update at Kyiv midnight. */
  referenceTimeMs: number | null;
  /** Auth user display name for background watermark */
  authUserName: string | null;
  tagContributionsOrganismId?: number;
  groupName: string | null;
  hideGroupName?: boolean;
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
  onCopyEtalon?: (value: string) => void;
  onCopyLocation?: (value: string) => void;
  onCreateReport?: (
    visibleEtalonDisplayModel: MessageCardEtalonDisplayModel,
    focusTarget: HTMLElement,
  ) => void;
  onEditReport?: (reportId: number) => void;
  onDelete?: () => void;
  onEditDetails?: (focusTarget: HTMLElement) => void;
  onExcludeMessageEntity?: (entity: MessageEntityFilterKind, value: string) => void;
  onToggleTag?: (tagId: number) => void;
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
  onAddPointHighlightBlacklist?: (request: AddPointHighlightBlacklistRequest) => Promise<void>;
  botTagAction?: MessageCardBotTagAction | null;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void | Promise<void>;
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
  displayMode = 'duty',
  analysisDestination = 'classic',
  tagsLayout = 'full',
  hideBotTags = false,
  hideNetworks = false,
  tagsLoading = false,
  referenceTimeMs,
  authUserName,
  tagContributionsOrganismId,
  groupName,
  hideGroupName = false,
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
  analysisCallsignActions,
  showCallsignAddForm = false,
  collapseMediaPreviews,
  mediaSummaryEnabled = DEFAULT_MEDIA_SUMMARY_ENABLED,
  messageTextPreviewLines = 20,
  messageTimeBasis = 'interception',
}: MessageCardProps) {
  const replies = useMessageReplies(id);
  const canWrite = useMessageWriteAccess();
  const canDelete = useMessageDeleteAccess();
  if (!canDelete) onDelete = undefined;
  if (!canWrite) {
    onEditDetails = undefined;
    onCreateReport = undefined;
    onEditReport = undefined;
    onToggleTag = undefined;
    onMarkBotTagWrong = undefined;
    botTagAction = null;
    analysisCallsignActions = undefined;
    showCallsignAddForm = false;
  }
  const downloadGuard = useMessageCardDownloadGuard();
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
  const visibleEtalonDisplayModel = useMemo(
    () =>
      hideNetworks
        ? hideMessageCardNetworks(etalonDisplayModel, msg.unitDisplay ?? msg.unit)
        : etalonDisplayModel,
    [hideNetworks, etalonDisplayModel, msg.unitDisplay, msg.unit],
  );
  const onCopyEtalonAction =
    visibleEtalonDisplayModel.copyEtalonValue == null || onCopyEtalon == null
      ? undefined
      : () => onCopyEtalon(visibleEtalonDisplayModel.copyEtalonValue!);
  const onCopyLocationAction =
    visibleEtalonDisplayModel.copyLocationValue == null || onCopyLocation == null
      ? undefined
      : () => onCopyLocation(visibleEtalonDisplayModel.copyLocationValue!);
  const pointEtalons = useMemo(() => getPointEtalonsFromMessage(msg, tagsMap), [msg, tagsMap]);
  const radioFeaturesAllowed = useRadioFeatures();
  const canUseMessageDevices = useMessageDeviceAccess();
  const dutyExcludeMenuEnabled = useContext(DutyExcludeMenuContext);
  const excludeSources = useMemo(
    () => ({
      group: { value: msg.groupMasterKey, label: groupName },
      sender: { value: msg.sender, label: senderName },
      freq: { value: radioFeaturesAllowed ? msg.freq : null, label: msg.freq },
      post: { value: radioFeaturesAllowed ? msg.post : null, label: msg.post },
    }),
    [
      radioFeaturesAllowed,
      msg.groupMasterKey,
      groupName,
      msg.sender,
      senderName,
      msg.freq,
      msg.post,
    ],
  );
  const excludeMenuOptions = useMemo(
    () =>
      displayMode === 'duty' && dutyExcludeMenuEnabled
        ? buildVisibleExcludeMenuOptions(filterState, excludeSources)
        : EMPTY_EXCLUDE_OPTIONS,
    [displayMode, dutyExcludeMenuEnabled, filterState, excludeSources],
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
    radioFeaturesAllowed && displayMode === 'analysis' && hasVisibleDmrMetadata(msg) ? (
      <MessageCardDmrMetadataPopover msg={msg} />
    ) : undefined;
  const showContentMetadata =
    hideNetworks ||
    isPresent(visibleEtalonDisplayModel.headerUnit) ||
    (radioFeaturesAllowed && isPresent(msg.freq)) ||
    (canUseMessageDevices && Boolean(msg.deviceName?.trim())) ||
    metadataTrigger != null;
  const headerMetadata = useMemo(
    () =>
      hideNetworks ? undefined : (
        <MessageCardMetadata
          msg={msg}
          groupName={hideGroupName ? null : groupName}
          senderName={senderName}
          etalonDisplayModel={visibleEtalonDisplayModel}
          placement={MessageCardMetadataPlacement.Header}
          wrapText
        />
      ),
    [hideNetworks, msg, hideGroupName, groupName, senderName, visibleEtalonDisplayModel],
  );
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
    displayMode,
    id,
    msg,
    copiedFeedbackId,
    etalonDisplayModel: visibleEtalonDisplayModel,
    metadata: headerMetadata,
    mapHref,
    analysisHref,
    onReply:
      replies.open == null ? undefined : (focus) => replies.open?.({ id, message: msg, focus }),
    onBookmark,
    onImportant,
    onCreateReport:
      onCreateReport == null
        ? undefined
        : (focusTarget) => onCreateReport(visibleEtalonDisplayModel, focusTarget),
    onCopyText,
    onCopyFreq: radioFeaturesAllowed ? onCopyFreq : undefined,
    onCopyTextWithNetwork: hideNetworks ? undefined : onCopyTextWithNetwork,
    onCopyTextWithNetworkAndNote: hideNetworks ? undefined : onCopyTextWithNetworkAndNote,
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
  const timestampFooter = (
    <MessageCardTimestampFooter msg={msg} referenceTimeMs={referenceTimeMs} />
  );

  return (
    <li
      data-message-id={id}
      data-message-uid={msg.messageUid ?? undefined}
      className="message-card-item list-none flex flex-col px-0 pb-[12px] mb-0"
      style={displayMode === 'analysis' ? ANALYSIS_MESSAGE_CARD_VISIBILITY_STYLE : undefined}
    >
      <MessageCardRoot
        data-message-card-root="true"
        data-message-card-display-mode={displayMode}
        data-important={msg.important ? 'true' : undefined}
        className="message-card-root relative flex w-full min-w-0 flex-col overflow-hidden"
      >
        {watermarkUserName !== '' && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
            <MessageCardWatermark authUserName={watermarkUserName} />
          </div>
        )}
        <MessageCardHeader {...headerProps} />
        <div className="message-card-divider" aria-hidden="true" />
        <MessageCardContentWithDownloadGuard
          timestampFooter={visibleMessageComments.length === 0 ? timestampFooter : undefined}
          metadata={
            showContentMetadata ? (
              <MessageCardMetadata
                msg={msg}
                groupName={hideGroupName ? null : groupName}
                senderName={senderName}
                etalonDisplayModel={visibleEtalonDisplayModel}
                metadataTrigger={metadataTrigger}
                placement={
                  hideNetworks
                    ? MessageCardMetadataPlacement.All
                    : MessageCardMetadataPlacement.Content
                }
                hideExplicitUnit
              />
            ) : undefined
          }
          replyContent={
            replies.snapshot.relations.length ? (
              <MessageReplyChain
                id={id}
                snapshot={replies.snapshot}
                timeBasis={displayMode === 'duty' ? 'creation' : messageTimeBasis}
              />
            ) : null
          }
          messageId={id}
          msg={msg}
          tagsMap={tagsMap}
          tagsOrder={tagsOrder}
          tagContributionsOrganismId={tagContributionsOrganismId}
          hideBotTags={hideBotTags}
          hideNetworks={hideNetworks}
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
          signalMessageSenderId={msg.sender}
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
        {visibleMessageComments.length > 0 ? timestampFooter : null}
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
