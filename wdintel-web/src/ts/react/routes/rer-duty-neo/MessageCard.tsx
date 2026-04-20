import { Box } from '@mui/material';
import { useMemo } from 'react';
import type { CallsignInfoRes, InboxMessage, Network, Tag, Unit } from '../../../../Bindings';
import { MessageCardMessageBody, MessageCardWatermark } from './MessageCardContent';
import { MessageCardHeader, type MessageCardDisplayMode, type MessageCardHeaderProps } from './MessageCardHeader';
import { useRelativeTimeDisplayMs } from './useRelativeTimeDisplayMs';
import {
  buildAnalysisHref,
  buildAnalysisMapHrefWithSearch,
  etalonFallbackWhenNoNetworks,
  getPointEtalonsFromMessage,
  type TagsLayoutVariant,
} from './utils';

/** Share of the header row (network vs relative time) reserved for etalon / network block. */
export const MESSAGE_CARD_HEADER_NETWORK_ROW_WIDTH_PCT = 90;

export type MessageCardProps = {
  id: number;
  msg: InboxMessage;
  /** Number of feeds (columns). When >= 3, header columns use differential shrink (left 3, center 2, right 0). When 1 or 2, all columns shrink equally. */
  feedCount?: number;
  /** Duty vs analysis: controls stacked action icon grid width (4 vs 3 columns). */
  displayMode?: MessageCardDisplayMode;
  /** Tag chips section visual density mode. */
  tagsLayout?: TagsLayoutVariant;
  /** Baseline "now" when the card is off-screen; while visible, relative time updates every minute. */
  referenceTimeMs: number | null;
  /** Auth user display name for background watermark */
  authUserName: string | null;
  groupName: string | null;
  senderName: string | null;
  copiedFeedbackId: string | null;
  networkDisplayMap: Record<number, string>;
  /** Loaded network models (for «в дорозвідці» badge); keys match `msg.networkIds`. */
  networkMap?: Record<number, Network>;
  /** When false, show `msg.unit` if network ids are empty (and freq present). */
  featureStrictNetworks?: boolean;
  tagsMap: Record<number, Tag>;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  networks?: Network[];
  unitsMap?: Record<number, Unit>;
  onBookmark: () => void;
  onImportant: () => void;
  onCopyText: () => void;
  onCopyFreq: () => void;
  onComment: () => void;
  onDelete?: () => void;
  onEditDetails?: () => void;
  onToggleTag: (tagId: number) => void;
  rightHeaderInsetPx?: number;
};

export function MessageCard({
  id,
  msg,
  feedCount = 1,
  displayMode = 'duty',
  tagsLayout = 'full',
  referenceTimeMs,
  authUserName,
  groupName,
  senderName,
  copiedFeedbackId,
  networkDisplayMap,
  networkMap = {},
  featureStrictNetworks = false,
  tagsMap,
  callsignInfoMap,
  networks,
  unitsMap,
  onBookmark,
  onImportant,
  onCopyText,
  onCopyFreq,
  onComment,
  onDelete,
  onEditDetails,
  onToggleTag,
  rightHeaderInsetPx = 0,
}: MessageCardProps) {
  const [messageRootRef, relativeTimeMs] = useRelativeTimeDisplayMs(referenceTimeMs, msg.timestamp);
  const networkIds = Array.from(new Set(msg.networkIds ?? []));
  const compactLayout = feedCount >= 3;
  const derivedNetworkMap = useMemo(() => {
    if (Object.keys(networkMap).length > 0) return networkMap;
    if (!networks) return {};
    return Object.fromEntries(networks.map((network) => [network.id, network]));
  }, [networkMap, networks]);
  const etalonNoNetworkLabel = etalonFallbackWhenNoNetworks(msg, { featureStrictNetworks });
  const pointEtalons = getPointEtalonsFromMessage(msg, tagsMap);
  const mapHref =
    pointEtalons.length > 0 ? buildAnalysisMapHrefWithSearch(pointEtalons, msg) : buildAnalysisHref(msg, true);
  const watermarkUserName = authUserName?.trim() ?? '';

  const headerProps: MessageCardHeaderProps = {
    compact: compactLayout,
    displayMode,
    networkRowContentWidthPct: MESSAGE_CARD_HEADER_NETWORK_ROW_WIDTH_PCT,
    id,
    msg,
    mapHref,
    copiedFeedbackId,
    groupName,
    senderName,
    networkIds,
    networkDisplayMap,
    networkMap: derivedNetworkMap,
    etalonNoNetworkLabel,
    relativeTimeMs,
    rightInsetPx: rightHeaderInsetPx,
    onBookmark,
    onImportant,
    onComment,
    onCopyText,
    onCopyFreq,
    onDelete,
    onEditDetails,
  };

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
        fontSize: 12,
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
          fontSize: 12,
          '& .MuiTypography-root': {
            fontSize: 12,
          },
          '& a': {
            fontSize: 12,
          },
        }}
      >
        {watermarkUserName !== '' && (
          <Box sx={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }} aria-hidden>
            <MessageCardWatermark authUserName={watermarkUserName} />
          </Box>
        )}
        <MessageCardHeader {...headerProps} />
        <MessageCardMessageBody msg={msg} tagsMap={tagsMap} onToggleTag={onToggleTag} tagsLayout={tagsLayout} callsignInfoMap={callsignInfoMap} networks={networks} unitsMap={unitsMap} />
      </Box>
    </Box>
  );
}
