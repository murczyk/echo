import { Box, Tooltip, Typography } from '@mui/material';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { useMemo } from 'react';
import type {
  CallsignInfoRes,
  InboxMessage,
  MessageComment,
  Network,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  Tag,
  Unit,
} from '../../../../../Bindings';
import { MessageCardContent } from './MessageCardContent';
import { MessageCardWatermark } from './MessageCardWatermark';
import type { AnalysisCallsignActions, MessageCardBotTagAction } from './message-card.types';
import {
  MessageCardHeader,
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
  buildVisibleExcludeMenuOptions,
  emptyFilter,
  getPointEtalonsFromMessage,
  messageRenderDistance,
  type MessageEntityFilterKind,
  type TagsLayoutVariant,
} from '../../rer-duty-neo/utils';
import { resolveMessageCardEtalonDisplayModel } from './message-card.utils';

/** Share of the header row (network vs relative time) reserved for etalon / network block. */
export const MESSAGE_CARD_HEADER_NETWORK_ROW_WIDTH_PCT = 90;

dayjs.extend(customParseFormat);

export function formatMessageCardTooltipTime(
  msg: Pick<InboxMessage, 'time' | 'timestamp'>,
): string {
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
  /** Tag chips section visual density mode. */
  tagsLayout?: TagsLayoutVariant;
  tagsLoading?: boolean;
  /** Baseline "now" when the card is off-screen; while visible, relative time updates every minute. */
  referenceTimeMs: number | null;
  /** Auth user display name for background watermark */
  authUserName: string | null;
  groupName: string | null;
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
  onCopyEtalon?: () => void;
  onCopyLocation?: () => void;
  onAddFrequencyToFilter?: (freq: string) => void;
  onComment?: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  onExcludeMessageEntity?: (entity: MessageEntityFilterKind, value: string) => void;
  onToggleTag?: (tagId: number) => void;
  onOpenPointsOnMap?: (etalons: string[], message: InboxMessage) => void;
  botTagAction?: MessageCardBotTagAction | null;
  onCancelBotTagAction?: () => void;
  onMarkBotTagWrong?: (messageId: number, tagId: number) => void | Promise<void>;
  rightHeaderInsetPx?: number;
  analysisCallsignActions?: AnalysisCallsignActions;
};

export function MessageCard({
  id,
  msg,
  readOnly = false,
  feedCount = 1,
  displayMode = 'duty',
  tagsLayout = 'full',
  tagsLoading = false,
  referenceTimeMs,
  authUserName,
  groupName,
  senderName,
  copiedFeedbackId,
  networkDisplayMap,
  filterState = emptyFilter(),
  messageComments = [],
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
  onCopyEtalon,
  onCopyLocation,
  onAddFrequencyToFilter,
  onComment,
  onDelete,
  onEditDetails,
  onExcludeMessageEntity,
  onToggleTag,
  onOpenPointsOnMap,
  botTagAction = null,
  onCancelBotTagAction,
  onMarkBotTagWrong,
  rightHeaderInsetPx = 0,
  analysisCallsignActions,
}: MessageCardProps) {
  const [messageRootRef, relativeTimeMs] = useRelativeTimeDisplayMs(referenceTimeMs, msg.timestamp);
  const compactLayout = feedCount >= 3;
  const derivedNetworkMap = useMemo(() => {
    if (Object.keys(networkMap).length > 0) return networkMap;
    if (!networks) return {};
    return Object.fromEntries(networks.map((network) => [network.id, network]));
  }, [networkMap, networks]);
  const etalonDisplayModel = resolveMessageCardEtalonDisplayModel(msg, {
    featureStrictNetworks,
    networkDisplayMap,
    networkMap: derivedNetworkMap,
    networks,
  });
  const onCopyEtalonAction = etalonDisplayModel.copyEtalonValue == null ? undefined : onCopyEtalon;
  const onCopyLocationAction =
    etalonDisplayModel.copyLocationValue == null ? undefined : onCopyLocation;
  const pointEtalons = getPointEtalonsFromMessage(msg, tagsMap);
  const excludeMenuOptions =
    displayMode === 'duty'
      ? buildVisibleExcludeMenuOptions(filterState, {
          group: { value: msg.groupMasterKey, label: groupName },
          sender: { value: msg.sender, label: senderName },
          freq: { value: msg.freq, label: msg.freq },
          post: { value: msg.post, label: msg.post },
        })
      : [];
  const mapHref =
    displayMode === 'duty'
      ? pointEtalons.length > 0
        ? buildClassicAnalysisMapHrefWithSearch(pointEtalons, msg)
        : buildClassicAnalysisHref(msg, true)
      : undefined;
  const watermarkUserName = authUserName?.trim() ?? '';
  const timeDistance =
    isPresent(msg.timestamp) && isPresent(relativeTimeMs)
      ? messageRenderDistance(msg.timestamp, relativeTimeMs)
      : null;
  const tooltipTime = formatMessageCardTooltipTime(msg);

  const topRight =
    displayMode === 'duty' ? (
      isPresent(timeDistance) ? (
        <Box sx={{ flex: '1 1 0', minWidth: 0, display: 'flex', justifyContent: 'flex-end' }}>
          {tooltipTime === NO_DATA_LABEL ? (
            <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
              {timeDistance}
            </Typography>
          ) : (
            <Tooltip title={tooltipTime} placement="top" enterDelay={300}>
              <Typography
                variant="caption"
                sx={{ color: 'text.secondary', whiteSpace: 'nowrap', cursor: 'default' }}
              >
                {timeDistance}
              </Typography>
            </Tooltip>
          )}
        </Box>
      ) : (
        <Box sx={{ minHeight: 28 }} />
      )
    ) : (
      <Box sx={{ minHeight: 28 }} />
    );

  const analysisHref = displayMode === 'duty' ? buildClassicAnalysisHref(msg, false) : undefined;
  const metadataTrigger =
    displayMode === 'analysis' && hasVisibleDmrMetadata(msg) ? (
      <MessageCardDmrMetadataPopover msg={msg} />
    ) : undefined;

  const headerProps: MessageCardHeaderProps = {
    compact: compactLayout,
    displayMode,
    networkRowContentWidthPct: MESSAGE_CARD_HEADER_NETWORK_ROW_WIDTH_PCT,
    id,
    msg,
    copiedFeedbackId,
    groupName,
    senderName,
    etalonDisplayModel,
    mapHref,
    analysisHref,
    rightInsetPx: rightHeaderInsetPx,
    topRight,
    onBookmark,
    onImportant,
    onComment,
    onCopyText,
    onCopyFreq,
    onCopyTextWithNetwork,
    onCopyTextWithNetworkAndNote,
    onCopyEtalon: onCopyEtalonAction,
    onCopyLocation: onCopyLocationAction,
    onAddFrequencyToFilter,
    onDelete,
    onEditDetails,
    onExcludeMessageEntity,
    metadataTrigger,
    excludeMenuOptions,
    readOnly,
  };
  const visibleMessageComments = messageComments;

  return (
    <Box
      ref={messageRootRef}
      component="li"
      sx={{
        listStyle: 'none',
        display: 'flex',
        flexDirection: 'column',
        pl: 0,
        pr: 0,
        pb: 1.5,
        mb: 0,
        fontSize: 14,
      }}
    >
      <Box
        sx={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          gap: compactLayout ? 1.25 : 1.5,
          width: '100%',
          px: 1.5,
          py: 1.25,
          borderRadius: 1,
          bgcolor: 'var(--color-card)',
          color: 'text.primary',
          overflow: 'hidden',
          fontSize: 14,
          '& .MuiTypography-root': {
            fontSize: 14,
          },
          '& a': {
            fontSize: 14,
          },
        }}
      >
        {watermarkUserName !== '' && (
          <Box
            sx={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
            aria-hidden
          >
            <MessageCardWatermark authUserName={watermarkUserName} />
          </Box>
        )}
        <MessageCardHeader {...headerProps} />
        <MessageCardContent
          msg={msg}
          tagsMap={tagsMap}
          tagsOrder={tagsOrder}
          tagsLoading={tagsLoading}
          onToggleTag={onToggleTag}
          readOnly={readOnly}
          tagsLayout={tagsLayout}
          botTagAction={botTagAction}
          onCancelBotTagAction={onCancelBotTagAction}
          onMarkBotTagWrong={onMarkBotTagWrong}
          analysisCallsignActions={analysisCallsignActions}
          callsignInfoMap={callsignInfoMap}
          networks={networks}
          unitsMap={unitsMap}
          messageComments={visibleMessageComments}
          signalMessageSenderLabel={senderName?.trim() ? senderName : msg.sender}
          searchText={searchText}
          onOpenPointsOnMap={onOpenPointsOnMap}
        />
      </Box>
    </Box>
  );
}

type BaseMessageCardProps = Omit<MessageCardProps, 'displayMode'>;

export function DutyMessageCard(props: BaseMessageCardProps) {
  return <MessageCard {...props} displayMode="duty" />;
}

export function AnalysisMessageCard(props: BaseMessageCardProps) {
  return <MessageCard {...props} displayMode="analysis" />;
}
